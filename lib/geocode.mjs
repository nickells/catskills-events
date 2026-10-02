import { readFileSync, writeFileSync, existsSync } from "fs";

const CACHE_FILE = "./output/geocache.json";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

let cache = {};

export function loadGeoCache() {
  if (existsSync(CACHE_FILE)) {
    cache = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
  }
}

export function saveGeoCache() {
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// Rough New York State bounds, for vetting coordinates cached before results were checked.
const NY_BOUNDS = { south: 40.49, north: 45.02, west: -79.77, east: -71.85 };

export function isInNewYork([lat, lng]) {
  return lat >= NY_BOUNDS.south && lat <= NY_BOUNDS.north && lng >= NY_BOUNDS.west && lng <= NY_BOUNDS.east;
}

// Free-text matches can land on a same-named place anywhere ("The Village Green, Hamilton, NY"
// matched Bowling Green, Ohio), so only results in New York count.
export function parseNominatimResult(data) {
  const hit = data?.[0];
  if (!hit || hit.address?.["ISO3166-2-lvl4"] !== "US-NY") return null;
  const addr = hit.address;
  const rawTown = addr.hamlet || addr.village || addr.town || addr.city || null;
  const town = rawTown?.replace(/^(Town|Village|City|Hamlet) of /i, "") || null;
  return { coords: [parseFloat(hit.lat), parseFloat(hit.lon)], town };
}

// `query` is free text, or { city } for a structured search, which finds the settlement
// rather than a same-named county ("Hamilton, NY" otherwise returns Hamilton County).
async function nominatim(query) {
  const params = new URLSearchParams({ format: "json", limit: "1", addressdetails: "1", countrycodes: "us" });
  if (typeof query === "string") params.set("q", query);
  else {
    params.set("city", query.city);
    params.set("state", "New York");
  }
  const res = await fetch(`${NOMINATIM_URL}?${params}`, {
    headers: { "User-Agent": "CatskillsEvents/1.0" },
  });
  if (!res.ok) return null;
  return parseNominatimResult(await res.json());
}

export async function geocodeEvents(events, townCoords) {
  let resolved = 0;
  let cached = 0;
  let queried = 0;

  const needsGeo = events.filter(e => {
    const tk = (e.town || "").toLowerCase().trim().replace(/,?\s*(ny|new york|usa)$/i, "").trim();
    const raw = (e.town || "").toLowerCase().trim();
    return !townCoords[tk] && !townCoords[raw];
  }).length;

  let geoIdx = 0;
  for (const event of events) {
    const rawTown = (event.town || "").toLowerCase().trim();
    const venueKey = (event.venue || "").toLowerCase().trim();

    // Normalize town: strip trailing state abbreviations and punctuation
    const townKey = rawTown
      .replace(/,?\s*(ny|new york|usa)$/i, "")
      .trim();

    // Try exact match, then with state suffix variants
    const townCoord = townCoords[townKey] || townCoords[rawTown];
    if (townCoord) {
      event._lat = townCoord[0];
      event._lng = townCoord[1];
      resolved++;
      continue;
    }

    // Check geocache by venue or town
    const cacheKey = venueKey || townKey;
    if (cache[cacheKey] !== undefined && (!cache[cacheKey] || isInNewYork(cache[cacheKey]))) {
      if (cache[cacheKey]) {
        event._lat = cache[cacheKey][0];
        event._lng = cache[cacheKey][1];
        resolved++;
      }
      cached++;
      continue;
    }

    // Build queries to try, in order of specificity
    // With a town, fall back to the town itself rather than the venue alone: a bare
    // "The Village Green, NY" matches some other village green across the state.
    const queries = [];
    if (event.venue && event.town) queries.push(`${event.venue}, ${event.town}, NY`);
    if (event.town) queries.push({ city: townKey });
    else if (event.venue) queries.push(`${event.venue}, NY`);

    if (!queries.length) continue;

    geoIdx++;
    console.log(`  Geocoding [${geoIdx}/${needsGeo}] ${(event.venue || event.town || "?").slice(0, 40)}`);

    let result = null;
    for (const q of queries) {
      result = await nominatim(q);
      queried++;
      if (result) break;
      await new Promise((r) => setTimeout(r, 1100));
    }
    cache[cacheKey] = result?.coords || null;

    if (result) {
      event._lat = result.coords[0];
      event._lng = result.coords[1];
      if (!event.town && result.town) event.town = result.town;
      resolved++;
    }

    // Nominatim rate limit: 1 req/sec
    await new Promise((r) => setTimeout(r, 1100));
  }

  saveGeoCache();
  console.log(
    `  Geocoded: ${resolved} resolved, ${cached} from cache, ${queried} API calls`
  );
}
