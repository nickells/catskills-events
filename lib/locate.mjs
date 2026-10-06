// Pins down where an event happens when its town can't be placed from town-coords
// (missing, misspelled, several towns, or a town outside the list): first from the
// event's own page, then from the model's knowledge, which also names the trail,
// mountain or park a hike is at for the geocoder to look up. Never guesses — an event it
// can't place keeps its town and is left for the geocoder.

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Pages that need a login or were already read as the event's source.
const UNREADABLE_HOSTS = /(^|\.)(instagram\.com|facebook\.com|fb\.me)$/i;

export const townKey = (town) => (town || "").toLowerCase().trim().replace(/,?\s*(ny|new york|usa)$/i, "").trim();

const cacheKey = (e) => `location:${e.url || ""}|${e.name || ""}|${e.venue || ""}|${e.town || ""}`;

function readableUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return /^https?:$/.test(protocol) && !UNREADABLE_HOSTS.test(hostname);
  } catch {
    return false;
  }
}

export async function locateEvents(events, {
  townCoords, fetchText, askPage, askKnowledge, cache = {}, now = Date.now(), concurrency = 4, log = () => {},
}) {
  const needs = events.filter((e) => !townCoords[townKey(e.town)] && (e.town || e.venue || e.url));
  const results = new Map();

  for (const e of needs) {
    const hit = cache[cacheKey(e)];
    if (hit && now - hit.ts < CACHE_TTL_MS) results.set(e, hit.events);
  }

  // 1. The event's own page usually states the venue's address.
  const fromPage = needs.filter((e) => !results.has(e) && e.url && readableUrl(e.url));
  let next = 0;
  async function worker() {
    while (next < fromPage.length) {
      const e = fromPage[next++];
      try {
        const text = await fetchText(e.url);
        const found = text ? await askPage(e, text) : null;
        if (found?.town) results.set(e, found);
      } catch (err) {
        log(`  ✗ ${e.name}: ${err.message.slice(0, 80)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, fromPage.length) }, worker));

  // 2. Otherwise the model's own knowledge of the venue and town, in one batch. A page
  // address without a state ("292 S Main Street, Sheffield") goes here too, with what
  // the page found, so the model can tell Sheffield, MA from a New York town.
  const pageWithoutState = new Map(needs.filter((e) => results.get(e)?.town && !results.get(e).state).map((e) => [e, results.get(e)]));
  const rest = needs.filter((e) => !results.has(e) || pageWithoutState.has(e));
  if (rest.length) {
    try {
      const answers = await askKnowledge(rest.map((e) => {
        const page = pageWithoutState.get(e);
        return page ? { ...e, venue: page.venue || e.venue, town: page.town } : e;
      }));
      rest.forEach((e, i) => {
        const page = pageWithoutState.get(e);
        const answer = answers[i]?.town || answers[i]?.landmark ? answers[i] : null;
        if (answer) results.set(e, page ? { ...page, ...answer, town: answer.town || page.town, venue: page.venue } : answer);
        else if (!page) results.set(e, null);
      });
    } catch (err) {
      log(`  ✗ Location lookup failed: ${err.message.slice(0, 80)}`);
    }
  }

  let located = 0;
  for (const e of needs) {
    if (!results.has(e)) continue;
    const found = results.get(e);
    cache[cacheKey(e)] = { ts: now, events: found };
    if (!found?.town && !found?.landmark) continue;
    log(`  ${e.name.slice(0, 40)}: ${e.town || "?"} → ${found.town ? `${found.town}, ${found.state || "NY"}` : ""}${found.landmark ? ` (${found.landmark})` : ""}`);
    if (found.town) {
      e.town = found.town;
      e._state = found.state || "NY";
    }
    if (found.landmark) e._landmark = found.landmark;
    if (found.venue && !e.venue) e.venue = found.venue;
    located++;
  }
  return { checked: needs.length, located };
}
