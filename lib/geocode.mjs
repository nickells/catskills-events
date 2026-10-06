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

// The Catskills and Hudson Valley with a margin (Albany to the Bronx, Binghamton to the
// Berkshires). A match outside it is a same-named place elsewhere.
const REGION = { south: 40.4, north: 43.6, west: -76.5, east: -72.8 };
const STATE_NAMES = { NY: "New York", PA: "Pennsylvania", NJ: "New Jersey", CT: "Connecticut", MA: "Massachusetts", VT: "Vermont" };
const PLACE_TYPES = new Set(["city", "town", "village", "hamlet", "suburb", "quarter", "neighbourhood", "locality", "isolated_dwelling", "municipality"]);

// The Catskills core, for landmark lookups: generic names recur statewide ("Mud Lake" first
// matched one near Syracuse).
const CORE = { south: 41.45, north: 42.6, west: -75.3, east: -73.55 };

const inBounds = ([lat, lng], b) => lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;

export function isInRegion(coords) {
  return inBounds(coords, REGION);
}

const squash = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// OSM names differ from how events write them: "Mount Utsayantha Fire Tower" is mapped as
// "Utsayantha Mountain", "Woodchuck Lodge" as "John Burroughs Woodchuck Lodge".
export function landmarkQueries(landmark) {
  const full = landmark.trim();
  const noSuffix = full.replace(/\s+(fire tower|trailhead|trail|summit|loop|hike)$/i, "");
  const noMount = noSuffix.replace(/^(mount|mt\.?)\s+/i, "");
  return [...new Set([full, noSuffix, noMount])];
}

// Free-text matches can land on a same-named place anywhere ("The Village Green, Hamilton, NY"
// matched Bowling Green, Ohio), so only results in the region count. A town lookup also has
// to return a settlement, not a street or county that shares its name.
// A landmark lookup (`name`) must return something actually called that, not a nearby
// "Hewlett Lodge" for "Woodchuck Lodge".
export function parseNominatimResult(data, { placeOnly = false, bounds = REGION, name = null } = {}) {
  const hit = data?.[0];
  if (!hit) return null;
  const coords = [parseFloat(hit.lat), parseFloat(hit.lon)];
  if (!inBounds(coords, bounds)) return null;
  if (placeOnly && !PLACE_TYPES.has(hit.addresstype)) return null;
  if (name) {
    const [want, got] = [squash(name), squash(hit.name)];
    if (!got || !(got.includes(want) || want.includes(got))) return null;
  }
  const addr = hit.address || {};
  const rawTown = addr.hamlet || addr.village || addr.town || addr.city || null;
  const town = rawTown?.replace(/^(Town|Village|City|Hamlet) of /i, "") || null;
  return { coords, town };
}

// `query` is free text, or { city, state } for a structured search, which finds the
// settlement rather than a same-named county ("Hamilton, NY" otherwise returns Hamilton County).
async function nominatim(query, { placeOnly = false, bounds = REGION, name = null } = {}) {
  const params = new URLSearchParams({
    format: "jsonv2", limit: "1", addressdetails: "1", countrycodes: "us",
    viewbox: `${bounds.west},${bounds.north},${bounds.east},${bounds.south}`, bounded: "1",
  });
  if (typeof query === "string") params.set("q", query);
  else {
    params.set("city", query.city);
    params.set("state", query.state);
  }
  const res = await fetch(`${NOMINATIM_URL}?${params}`, {
    headers: { "User-Agent": "CatskillsEvents/1.0" },
  });
  if (!res.ok) return null;
  return parseNominatimResult(await res.json(), { placeOnly, bounds, name });
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

    // A field like "Rhinebeck & Saugerties" is looked up by its first town.
    const firstTown = townKey.split(/\s*(?:&|\/|,|\band\b)\s*/)[0];
    const state = STATE_NAMES[event._state] || "New York";

    // town-coords only lists New York towns, so a Sheffield, MA mustn't match there.
    const townCoord = state === "New York" && (townCoords[townKey] || townCoords[rawTown] || townCoords[firstTown]);
    if (townCoord) {
      event._lat = townCoord[0];
      event._lng = townCoord[1];
      resolved++;
      continue;
    }

    // Check geocache by venue and town
    const cacheKey = `${venueKey}|${townKey}|${state}|${event._landmark || ""}`;
    if (cache[cacheKey] !== undefined && (!cache[cacheKey] || isInRegion(cache[cacheKey]))) {
      if (cache[cacheKey]) {
        event._lat = cache[cacheKey][0];
        event._lng = cache[cacheKey][1];
        resolved++;
      }
      cached++;
      continue;
    }

    // The town (corrected by locateEvents when needed) as a settlement, then the venue in
    // that town for hamlets Nominatim doesn't list. A venue alone is never searched: a bare
    // "The Village Green, NY" matched one near Buffalo.
    // A named landmark (from locateEvents) is the most precise, so it goes first.
    const queries = [];
    if (event._landmark) {
      for (const q of landmarkQueries(event._landmark)) queries.push([q, { bounds: CORE, name: q }]);
    }
    if (firstTown) queries.push([{ city: firstTown, state }, { placeOnly: true }]);
    if (event.venue && firstTown) queries.push([`${event.venue}, ${firstTown}, ${state}`, {}]);

    if (!queries.length) continue;

    geoIdx++;
    console.log(`  Geocoding [${geoIdx}/${needsGeo}] ${(event.venue || event.town || "?").slice(0, 40)}`);

    let result = null;
    for (const [q, opts] of queries) {
      result = await nominatim(q, opts);
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
