import { fetchPage } from "../fetch.mjs";
import { readCalendar } from "../calendars.mjs";
import { readNewsletter } from "./newsletter.mjs";
import { readPages } from "./page.mjs";
import { readTockify } from "./tockify.mjs";
import { cachedEvents } from "./cached.mjs";
export { readInstagram } from "./instagram.mjs";

// A venue's own website calendar, read without an LLM (see calendars.mjs).
function readVenueCalendar(source, { cache }) {
  return cachedEvents(cache, `calendar:${source.url}`, {
    name: source.name,
    sourceUrl: source.url,
    read: () => {
      console.log(`\n[${source.name}] Reading ${source.calendar} calendar`);
      return readCalendar(source, { fetchPage });
    },
  });
}

export const READERS = {
  "newsletter-archive": readNewsletter,
  "calendar": readPages,
  "tockify": readTockify,
  "venue-calendar": readVenueCalendar,
};

// Every source's events, read by its type's reader; one failing source doesn't stop the rest.
export async function readSources(sources, ctx, readers = READERS) {
  const events = [];
  for (const source of sources) {
    try {
      const read = readers[source.type];
      if (!read) throw new Error(`no reader for type "${source.type}"`);
      events.push(...await read(source, ctx));
    } catch (err) {
      console.error(`  ✗ Error processing ${source.name}: ${err.message}`);
    }
    ctx.cache.save();
  }
  return events;
}
