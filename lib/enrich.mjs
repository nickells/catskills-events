import { fetchPage } from "./fetch.mjs";
import { resolveVenueTowns, locateFromPage, locateFromKnowledge } from "./openai.mjs";
import { deduplicateEvents } from "./dedup.mjs";
import { filterOutsideNewYork } from "./location.mjs";
import { categorizeEvents } from "./categorize.mjs";
import { formatJSON } from "./format.mjs";
import { loadGeoCache, geocodeEvents } from "./geocode.mjs";
import { locateEvents } from "./locate.mjs";
import { cleanEvent, townCase } from "./clean.mjs";
import { parseHtml } from "./html.mjs";
import { TOWN_COORDS } from "./towns.mjs";

// Each stage takes the events and the run's context and returns the events it passes on.

function clean(events) {
  // Cached web-source events predate the cleanup in extractEvents.
  events.forEach(cleanEvent);
  return events;
}

// Drop events clearly outside New York (e.g. same-named towns elsewhere)
function dropOutOfState(events) {
  const { kept, dropped } = filterOutsideNewYork(events);
  if (dropped.length) {
    console.log(`\n--- Location filter ---`);
    console.log(`Dropped ${dropped.length} events outside New York`);
    for (const e of dropped) console.log(`  ✗ ${e.name} @ ${e.venue}`);
  }
  return kept;
}

function dedupe(events) {
  console.log(`\n--- Deduplication ---`);
  console.log(`Before: ${events.length} events`);
  const deduped = deduplicateEvents(events);
  console.log(`After: ${deduped.length} events`);
  return deduped;
}

// Missing towns (and address-as-venue-name) from the LLM, by venue.
async function resolveTowns(events) {
  const needsTown = events.filter((e) => !e.town && e.venue);
  if (!needsTown.length) return events;
  const uniqueVenues = [...new Set(needsTown.map((e) => e.venue))];
  console.log(`\n--- Town Resolution (${uniqueVenues.length} venues) ---`);
  const venueMap = await resolveVenueTowns(uniqueVenues);
  let filled = 0;
  for (const e of needsTown) {
    const info = venueMap[e.venue];
    if (!info) continue;
    if (info.venueName) e.venue = info.venueName;
    if (info.town) {
      e.town = info.town;
      filled++;
    }
  }
  console.log(`  Resolved ${filled}/${needsTown.length} events`);
  return events;
}

// Strip state suffixes like ", NY" or " New York", and fix all-caps casing.
function normalizeTowns(events) {
  for (const e of events) {
    if (e.town) e.town = townCase(e.town.replace(/,?\s*(NY|New York|USA)$/i, "").trim());
  }
  return events;
}

// Pin down upcoming events whose town can't be placed (missing, misspelled, several towns,
// or not in town-coords) from their own page or the model's knowledge, so they get a distance.
async function locate(events, { cache }) {
  console.log(`\n--- Location ---`);
  const today = new Date().toISOString().slice(0, 10);
  const { checked, located } = await locateEvents(events.filter((e) => !e.date || e.date >= today), {
    townCoords: TOWN_COORDS,
    fetchText: async (url) => {
      const html = await fetchPage(url);
      return html ? parseHtml(html, url).body : null;
    },
    askPage: locateFromPage,
    askKnowledge: locateFromKnowledge,
    cache: cache.data,
    log: console.log,
  });
  console.log(`  Located ${located}/${checked} events`);
  cache.save();
  return events;
}

async function geocode(events) {
  loadGeoCache();
  console.log(`\n--- Geocoding ---`);
  await geocodeEvents(events, TOWN_COORDS);
  for (const e of events) {
    delete e._state;
    delete e._landmark;
  }
  return events;
}

// Classify only publishable events, after merging evidence from duplicate sources.
async function categorize(events, { cache }) {
  console.log(`\n--- Event Categorization ---`);
  await categorizeEvents(formatJSON(events), cache.data);
  cache.save();
  return events;
}

export const STAGES = [clean, dropOutOfState, dedupe, resolveTowns, normalizeTowns, locate, geocode, categorize];

export async function enrichEvents(events, ctx, stages = STAGES) {
  for (const stage of stages) events = await stage(events, ctx);
  return events;
}
