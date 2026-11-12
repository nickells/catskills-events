import { fetchPage } from "./fetch.mjs";
import { locateFromPage, locateFromKnowledge } from "./openai.mjs";
import { deduplicateEvents } from "./dedup.mjs";
import { filterOutsideNewYork } from "./location.mjs";
import { categorizeEvents } from "./categorize.mjs";
import { upcoming } from "./format.mjs";
import { loadGeoCache, geocodeEvents } from "./geocode.mjs";
import { locateEvents } from "./locate.mjs";
import { cleanEvent, townCase } from "./clean.mjs";
import { parseHtml } from "./html.mjs";
import { stripState } from "./places.mjs";
import { TOWN_COORDS } from "./towns.mjs";

// Each stage takes the events and the run's context and returns the events it passes on.
// Places are settled before dedupe, so it compares corrected towns; geocoding and
// categorizing run once per merged event.

function clean(events) {
  // Cached web-source events predate the cleanup in extractEvents.
  events.forEach(cleanEvent);
  return events;
}

// Past events are never published, so no later stage spends lookups on them.
function dropPast(events) {
  return upcoming(events);
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

// Strip state suffixes like ", NY" or " New York", and fix all-caps casing.
function normalizeTowns(events) {
  for (const e of events) {
    if (e.town) e.town = townCase(stripState(e.town));
  }
  return events;
}

// Pin down events whose town can't be placed (missing, misspelled, several towns, or not in
// town-coords) from their own page or the model's knowledge, so they get a distance. An
// Instagram post nobody could place falls back to its account's town (see withAccountTown).
async function locate(events, { cache }) {
  console.log(`\n--- Location ---`);
  const { checked, located } = await locateEvents(events, {
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
  for (const e of events) {
    if (!e.town && e._fallbackTown) e.town = e._fallbackTown;
    delete e._fallbackTown;
  }
  cache.save();
  return events;
}

function dedupe(events) {
  console.log(`\n--- Deduplication ---`);
  console.log(`Before: ${events.length} events`);
  const deduped = deduplicateEvents(events);
  console.log(`After: ${deduped.length} events`);
  return deduped;
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

// Classify after merging evidence from duplicate sources.
async function categorize(events, { cache }) {
  console.log(`\n--- Event Categorization ---`);
  await categorizeEvents(events, cache.data);
  cache.save();
  return events;
}

export const STAGES = [clean, dropPast, dropOutOfState, normalizeTowns, locate, dedupe, geocode, categorize];

export async function enrichEvents(events, ctx, stages = STAGES) {
  for (const stage of stages) events = await stage(events, ctx);
  return events;
}
