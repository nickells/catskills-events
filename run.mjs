import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import * as cheerio from "cheerio";
import { fetchPage } from "./lib/fetch.mjs";
import { extractEvents } from "./lib/openai.mjs";
import { deduplicateEvents } from "./lib/dedup.mjs";
import { formatEvents, formatJSON } from "./lib/format.mjs";
import { loadGeoCache, geocodeEvents } from "./lib/geocode.mjs";
import { WEB_SOURCES } from "./lib/sources.mjs";

const KNOWN_TOWNS = new Set(
  Object.keys(JSON.parse(readFileSync("./lib/town-coords.json", "utf-8")))
);

const OUTPUT_DIR = "./output";
const CONCURRENCY = 5;
const SCRAPE_CACHE_FILE = `${OUTPUT_DIR}/scrape-cache.json`;
const CACHE_TTL_MS = 20 * 60 * 60 * 1000; // 20 hours

let scrapeCache = {};

function loadScrapeCache() {
  if (existsSync(SCRAPE_CACHE_FILE)) {
    scrapeCache = JSON.parse(readFileSync(SCRAPE_CACHE_FILE, "utf-8"));
  }
}

function saveScrapeCache() {
  writeFileSync(SCRAPE_CACHE_FILE, JSON.stringify(scrapeCache, null, 2));
}

function getCached(url) {
  const entry = scrapeCache[url];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) return null;
  return entry.events;
}

function setCache(url, events) {
  scrapeCache[url] = { ts: Date.now(), events };
}

// --- Town helpers ---

const ALLEVENTS_TOWN_RE = /allevents\.in\/([^/]+)\/all/;
const TOWN_SUFFIXES = ["-ny", "-new-york"];

function extractTownFromUrl(url) {
  const m = url.match(ALLEVENTS_TOWN_RE);
  if (!m) return null;
  let slug = m[1];
  for (const suffix of TOWN_SUFFIXES) {
    if (slug.endsWith(suffix)) slug = slug.slice(0, -suffix.length);
  }
  return slug.split("-").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function backfillTown(event, townHint) {
  // Extract town from venue parens only if it's a known town name
  if (!event.town && event.venue) {
    const m = event.venue.match(/\(([^)]+)\)\s*$/);
    if (m && KNOWN_TOWNS.has(m[1].toLowerCase().trim())) {
      event.town = m[1];
      event.venue = event.venue.replace(/\s*\([^)]+\)\s*$/, "").trim();
    }
  }
  if (!event.town && townHint) {
    event.town = townHint;
  }
}

// --- Helpers ---

async function pool(items, fn, concurrency) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

function parseHtml(html) {
  const $ = cheerio.load(html);
  const pageTitle = $("title").text().trim();
  const h1 = $("h1").first().text().trim();
  $("script, style, nav, footer, noscript, iframe, svg").remove();
  // Convert links to markdown-style so the LLM can see URLs
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().trim();
    if (href && text && href.startsWith("http")) {
      $(el).replaceWith(`[${text}](${href})`);
    }
  });
  // Preserve some structure: add newlines around block elements
  $("h1, h2, h3, h4, h5, h6, p, li, tr, br, div").each((_, el) => {
    $(el).prepend("\n");
  });
  const body = $.text().replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { pageTitle, h1, body };
}

// --- Source handlers ---

async function handleNewsletterArchive(source) {
  console.log(`\n[${source.name}] Discovering latest issue...`);
  const archiveHtml = await fetchPage(source.discoverUrl);
  if (!archiveHtml) {
    console.log(`  ✗ Failed to fetch archive`);
    return [];
  }

  // Find the latest issue link from Beehiiv archive page
  const $ = cheerio.load(archiveHtml);
  const links = [];
  $("a[href*='/p/']").each((_, el) => {
    const href = $(el).attr("href");
    if (href && !links.includes(href)) links.push(href);
  });

  if (!links.length) {
    console.log(`  ✗ No issue links found`);
    return [];
  }

  // Fetch the 2 most recent issues — this week's structured events
  // may be split across the latest and previous issue
  const issuesToFetch = links.slice(0, 2);
  const allEvents = [];

  for (const link of issuesToFetch) {
    const issueUrl = link.startsWith("http")
      ? link
      : `https://catskillcrew.beehiiv.com${link}`;

    const cached = getCached(issueUrl);
    if (cached) {
      console.log(`  ✓ ${cached.length} events (cached) — ${issueUrl}`);
      allEvents.push(...cached);
      continue;
    }

    console.log(`  Fetching: ${issueUrl}`);
    const issueHtml = await fetchPage(issueUrl);
    if (!issueHtml) {
      console.log(`  ✗ Failed to fetch`);
      continue;
    }

    let { pageTitle, h1, body } = parseHtml(issueHtml);

    // Catskill Crew: the structured event listings start at a day header
    // Find the earliest one to trim prose/promos before it
    const dayHeaders = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
    let earliestIdx = -1;
    for (const day of dayHeaders) {
      const idx = body.indexOf(day);
      if (idx > 0 && (earliestIdx === -1 || idx < earliestIdx)) {
        earliestIdx = idx;
      }
    }
    if (earliestIdx > 0) {
      body = body.slice(earliestIdx);
    }

    const events = await extractEvents(body, source.name, { pageTitle, h1 });
    console.log(`  ✓ ${events.length} events extracted`);
    const tagged = events.map((e) => ({ ...e, source: source.name, sourceUrl: issueUrl }));
    setCache(issueUrl, tagged);
    allEvents.push(...tagged);
  }

  return allEvents;
}

async function handleCalendar(source) {
  const allEvents = [];

  for (const url of source.urls) {
    const cached = getCached(url);
    if (cached) {
      console.log(`\n[${source.name}] ✓ ${cached.length} events (cached)`);
      allEvents.push(...cached);
      continue;
    }

    console.log(`\n[${source.name}] Fetching ${url}`);
    const html = await fetchPage(url);
    if (!html) {
      console.log(`  ✗ Failed to fetch`);
      continue;
    }

    const { pageTitle, h1, body } = parseHtml(html);
    const townHint = extractTownFromUrl(url);
    const events = await extractEvents(body, source.name, { pageTitle, h1 });
    console.log(`  ✓ ${events.length} events extracted`);
    const tagged = events.map((e) => {
      backfillTown(e, townHint);
      return { ...e, source: source.name, sourceUrl: url };
    });
    setCache(url, tagged);
    saveScrapeCache();
    allEvents.push(...tagged);
  }

  return allEvents;
}

async function handleVenues() {
  const venuesFile = `${OUTPUT_DIR}/venues-with-events.json`;
  if (!existsSync(venuesFile)) {
    console.log(`\n[Venues] No venues file found — run discover-venues.mjs and find-event-pages.mjs first`);
    return [];
  }

  const venues = JSON.parse(readFileSync(venuesFile, "utf-8"));
  console.log(`\n[Venues] Scraping ${venues.length} venue event pages...`);

  let done = 0;
  let cacheHits = 0;
  const results = await pool(
    venues,
    async (venue) => {
      done++;
      const cached = getCached(venue.eventPageUrl);
      if (cached) {
        cacheHits++;
        console.log(`  [${done}/${venues.length}] ${venue.name} — ${cached.length} events (cached)    `);
        return cached;
      }

      const html = await fetchPage(venue.eventPageUrl);
      if (!html) {
        console.log(`  [${done}/${venues.length}] ${venue.name} — skipped    `);
        return [];
      }

      const { pageTitle, h1, body } = parseHtml(html);
      const events = await extractEvents(body, venue.name, { pageTitle, h1 });
      console.log(`  [${done}/${venues.length}] ${venue.name} — ${events.length} events    `);
      const tagged = events.map((e) => ({
        ...e,
        venue: e.venue || venue.name,
        town: e.town || venue.address?.split(",")[1]?.trim(),
        source: venue.name,
        sourceUrl: venue.eventPageUrl,
      }));
      setCache(venue.eventPageUrl, tagged);
      return tagged;
    },
    CONCURRENCY
  );

  const allEvents = results.flat();
  console.log(`\n  ✓ ${allEvents.length} total venue events (${cacheHits} cached)`);
  return allEvents;
}

// --- Main ---

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  loadScrapeCache();
  console.log("=== Catskills Event Aggregator ===\n");

  const allEvents = [];

  // Process web sources
  for (const source of WEB_SOURCES) {
    try {
      let events;
      if (source.type === "newsletter-archive") {
        events = await handleNewsletterArchive(source);
      } else {
        events = await handleCalendar(source);
      }
      allEvents.push(...events);
    } catch (err) {
      console.error(`  ✗ Error processing ${source.name}: ${err.message}`);
    }
  }

  // Process venue sites
  try {
    const venueEvents = await handleVenues();
    allEvents.push(...venueEvents);
  } catch (err) {
    console.error(`  ✗ Error processing venues: ${err.message}`);
  }

  // Deduplicate
  console.log(`\n--- Deduplication ---`);
  console.log(`Before: ${allEvents.length} events`);
  const deduped = deduplicateEvents(allEvents);
  console.log(`After: ${deduped.length} events`);

  // Geocode events and add coordinates
  loadGeoCache();
  const townCoords = JSON.parse(readFileSync("./lib/town-coords.json", "utf-8"));
  console.log(`\n--- Geocoding ---`);
  await geocodeEvents(deduped, townCoords);

  // Save caches
  saveScrapeCache();

  // Output
  const markdown = formatEvents(deduped);
  const json = formatJSON(deduped);

  writeFileSync(`${OUTPUT_DIR}/events.md`, markdown);
  writeFileSync(`${OUTPUT_DIR}/events.json`, JSON.stringify(json, null, 2));

  console.log(`\n--- Done ---`);
  console.log(`Saved ${deduped.length} events to output/events.md and output/events.json`);
  console.log(`\n${markdown.slice(0, 2000)}...`);
}

main().catch(console.error);
