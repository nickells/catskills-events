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

async function nominatim(query) {
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=1`;
  const res = await fetch(url, {
    headers: { "User-Agent": "CatskillsEvents/1.0" },
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.length) return null;
  const addr = data[0].address || {};
  const rawTown = addr.hamlet || addr.village || addr.town || addr.city || null;
  const town = rawTown?.replace(/^(Town|Village|City|Hamlet) of /i, "") || null;
  return { coords: [parseFloat(data[0].lat), parseFloat(data[0].lon)], town };
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
    if (cache[cacheKey] !== undefined) {
      if (cache[cacheKey]) {
        event._lat = cache[cacheKey][0];
        event._lng = cache[cacheKey][1];
        resolved++;
      }
      cached++;
      continue;
    }

    // Build queries to try, in order of specificity
    const queries = [];
    if (event.venue && event.town) queries.push(`${event.venue}, ${event.town}, NY`);
    if (event.venue) queries.push(`${event.venue}, NY`);
    if (event.town) queries.push(`${event.town}, NY`);

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
