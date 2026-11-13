import { fetchPage } from "./fetch.mjs";
import { locateFromPage, locateFromKnowledge } from "./openai.mjs";
import { deduplicateEvents } from "./dedup.mjs";
import { filterOutsideNewYork } from "./location.mjs";
import { categorizeEvents } from "./categorize.mjs";
import { upcoming } from "./format.mjs";
import { loadGeoCache, geocodeEvents } from "./geocode.mjs";
import { locateEvents } from "./locate.mjs";
import { cleanEvent, townCase, dropClosures } from "./clean.mjs";
import { parseHtml } from "./html.mjs";
import { stripState } from "./places.mjs";
import { postedAt } from "./instagram.mjs";
import { TOWN_COORDS } from "./towns.mjs";

// Each stage takes the events and the run's context and returns the events it passes on.
// Places are settled before dedupe, so it compares corrected towns; geocoding and
// categorizing run once per merged event.

function clean(events) {
  // Cached web-source events predate the cleanup in extractEvents.
  events.forEach(cleanEvent);
  return events;
}

// An undated event from a post this old is most likely over: by mid-November, posts about
// Halloween parties and Oktoberfest were still listed. Posts a few days old are kept, since
// "this Friday" from a recent post is still ahead.
export const UNDATED_POST_MAX_AGE_MS = 10 * 24 * 60 * 60 * 1000;

// Past events are never published, so no later stage spends lookups on them.
export function dropPast(events, _ctx, now = Date.now()) {
  const current = upcoming(events, new Date(now));
  const kept = current.filter((e) => {
    const posted = e.date ? null : postedAt(e);
    return !posted || now - posted <= UNDATED_POST_MAX_AGE_MS;
  });
  const stale = current.length - kept.length;
  if (stale) console.log(`\nDropped ${stale} undated events from posts over 10 days old`);
  for (const e of kept) delete e._postedAt;
  return kept;
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

// After dedupe, so a closure is matched against each event's settled venue.
function dropClosed(events) {
  const kept = dropClosures(events);
  if (kept.length < events.length) console.log(`Dropped ${events.length - kept.length} closing notices and the events they cancel`);
  return kept;
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

export const STAGES = [clean, dropPast, dropOutOfState, normalizeTowns, locate, dedupe, dropClosed, geocode, categorize];

export async function enrichEvents(events, ctx, stages = STAGES) {
  for (const stage of stages) events = await stage(events, ctx);
  return events;
}
