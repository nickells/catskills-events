import { setTimeout as sleep } from "node:timers/promises";
import { fetchPage, fetchPageWithBrowser } from "../fetch.mjs";
import { extractEvents } from "../openai.mjs";
import { extractJsonLdEvents } from "../jsonld.mjs";
import { parseHtml } from "../html.mjs";
import { KNOWN_TOWNS } from "../towns.mjs";
import { cachedEvents } from "./cached.mjs";

// "https://allevents.in/hudson-ny/all" → "Hudson"
export function townFromUrl(url) {
  const slug = url.match(/allevents\.in\/([^/]+)\/all/)?.[1].replace(/-(ny|new-york)$/, "");
  return slug ? slug.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") : null;
}

// Moves a known town out of "Venue (Town)", or falls back to the page's town.
export function backfillTown(event, townHint) {
  if (!event.town && event.venue) {
    const m = event.venue.match(/\(([^)]+)\)\s*$/);
    if (m && KNOWN_TOWNS.has(m[1].toLowerCase().trim())) {
      event.town = m[1];
      event.venue = event.venue.replace(/\s*\([^)]+\)\s*$/, "").trim();
    }
  }
  if (!event.town && townHint) event.town = townHint;
  return event;
}

async function readPage(url, source) {
  console.log(`\n[${source.name}] Fetching ${url}`);
  const html = await fetchPage(url);
  if (!html) throw new Error(`Failed to fetch ${url}`);

  // Listing sites publish their events as schema.org JSON-LD; read that when the source has
  // it, and fall back to the LLM only for a page that doesn't.
  let events = source.structured ? extractJsonLdEvents(html) : [];
  if (events.length) console.log(`  → ${events.length} events from structured data`);
  else events = await extractEvents(...extractArgs(html, url, source));

  // The page may be JS-rendered — retry with Playwright
  if (!events.length) {
    console.log(`  → 0 events from static HTML, trying browser render...`);
    const rendered = await fetchPageWithBrowser(url);
    if (rendered) events = await extractEvents(...extractArgs(rendered, url, source));
  }
  const townHint = townFromUrl(url);
  return events.map((e) => backfillTown(e, townHint));
}

function extractArgs(html, url, source) {
  const { pageTitle, h1, body } = parseHtml(html, url);
  return [body, source.name, { pageTitle, h1 }];
}

// Event listing pages read by the LLM (or their JSON-LD), one cache entry per page.
export async function readPages(source, { cache }) {
  const events = [];
  let fetched = 0;
  for (const url of source.urls) {
    events.push(...await cachedEvents(cache, url, {
      name: source.name,
      sourceUrl: url,
      read: async () => {
        // Pace requests to sites that ask for a crawl delay.
        if (source.delayMs && fetched++) await sleep(source.delayMs);
        return readPage(url, source);
      },
    }).catch((err) => {
      console.log(`  ✗ ${err.message}`);
      return [];
    }));
  }
  return events;
}
