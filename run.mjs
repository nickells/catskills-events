import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import * as cheerio from "cheerio";
import { fetchPage, fetchPageWithBrowser, closeBrowser } from "./lib/fetch.mjs";
import { extractEvents, resolveVenueTowns, ocrEventImage } from "./lib/openai.mjs";
import { deduplicateEvents } from "./lib/dedup.mjs";
import { formatEvents, formatJSON } from "./lib/format.mjs";
import { loadGeoCache, geocodeEvents } from "./lib/geocode.mjs";
import { WEB_SOURCES, INSTAGRAM_SOURCES } from "./lib/sources.mjs";
import { scrapeInstagramProfiles, formatPostsForLLM } from "./lib/instagram.mjs";

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

function parseHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const pageTitle = $("title").text().trim();
  const h1 = $("h1").first().text().trim();
  $("script, style, nav, footer, noscript, iframe, svg").remove();
  // Resolve relative URLs and convert links to markdown-style so the LLM can see them
  $("a[href]").each((_, el) => {
    let href = $(el).attr("href");
    const text = $(el).text().trim();
    if (!href || !text) return;
    if (href.startsWith("/") && baseUrl) {
      try { href = new URL(href, baseUrl).href; } catch {}
    }
    if (href.startsWith("http")) {
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

    let { pageTitle, h1, body } = parseHtml(issueHtml, issueUrl);

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

    let { pageTitle, h1, body } = parseHtml(html, url);
    const townHint = extractTownFromUrl(url);
    let events = await extractEvents(body, source.name, { pageTitle, h1 });

    // Fallback: if 0 events, the page may be JS-rendered — retry with Playwright
    if (!events.length) {
      console.log(`  → 0 events from static HTML, trying browser render...`);
      const rendered = await fetchPageWithBrowser(url);
      if (rendered) {
        ({ pageTitle, h1, body } = parseHtml(rendered, url));
        events = await extractEvents(body, source.name, { pageTitle, h1 });
      }
    }

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

const TOCKIFY_CATEGORY_MAP = {
  "music": "music", "concert": "music", "live-music": "music", "jazz": "music", "bluegrass": "music",
  "food": "food", "drinks": "food", "cider": "food", "beer": "food", "market": "food", "farmers-market": "food",
  "art": "culture", "theater": "culture", "film": "culture", "workshop": "culture", "class": "culture",
  "pottery": "culture", "reading": "culture", "lecture": "culture", "history": "culture",
  "hike": "nature", "hiking": "nature", "outdoor": "nature", "garden": "nature", "nature": "nature",
  "fundraiser": "community", "festival": "community", "parade": "community", "fair": "community",
  "yoga": "wellness", "meditation": "wellness", "wellness": "wellness",
  "comedy": "nightlife", "trivia": "nightlife",
};

function tockifyCategory(tags) {
  for (const tag of tags) {
    const mapped = TOCKIFY_CATEGORY_MAP[tag.toLowerCase()];
    if (mapped) return mapped;
  }
  return "community";
}

async function handleTockify(source) {
  const cacheKey = `tockify:${source.tockifyCalendar}`;
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`\n[${source.name}] ✓ ${cached.length} events (cached)`);
    return cached;
  }

  const startMs = Date.now();
  const url = `https://tockify.com/api/ngevent?calname=${source.tockifyCalendar}&max=100&startms=${startMs}`;
  console.log(`\n[${source.name}] Fetching Tockify API...`);

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`  ✗ Tockify API returned ${res.status}`);
      return [];
    }
    const data = await res.json();
    const events = (data.events || []).map((e) => {
      const c = e.content || {};
      const w = e.when || {};
      const start = w.start?.millis;
      const loc = c.location || {};
      const tags = c.tagset?.tags?.default || [];

      const date = start ? new Date(start).toISOString().slice(0, 10) : null;
      const timeStr = start ? new Date(start).toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York",
      }) : null;

      const tagTown = tags.find((t) => KNOWN_TOWNS.has(t.toLowerCase()));
      const town = loc.c_locality || tagTown || null;

      return {
        name: c.summary?.text || "Unknown Event",
        date,
        time: timeStr,
        venue: c.place || null,
        town,
        description: c.description?.text?.slice(0, 200) || null,
        url: c.customButtonLink || null,
        category: tockifyCategory(tags),
        source: source.name,
        sourceUrl: `https://greatwesterncatskills.com/events/`,
        _lat: loc.latitude || null,
        _lng: loc.longitude || null,
      };
    }).filter((e) => e.date);

    // Skip online events
    const filtered = events.filter((e) => {
      const name = (e.name || "").toLowerCase();
      return !name.includes("online") || name.includes("from ");
    });

    console.log(`  ✓ ${filtered.length} events from Tockify API`);
    setCache(cacheKey, filtered);
    saveScrapeCache();
    return filtered;
  } catch (err) {
    console.log(`  ✗ Tockify error: ${err.message}`);
    return [];
  }
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

      const { pageTitle, h1, body } = parseHtml(html, venue.eventPageUrl);
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

async function handleInstagram() {
  console.log(`\n[Instagram] Scraping ${INSTAGRAM_SOURCES.length} profiles...`);

  const profiles = await scrapeInstagramProfiles(INSTAGRAM_SOURCES);
  const allEvents = [];

  for (const profile of profiles) {
    if (!profile.posts.length) continue;

    const cacheKey = `instagram:${profile.handle}`;
    const cached = getCached(cacheKey);
    if (cached) {
      console.log(`  @${profile.handle} — ${cached.length} events (cached)`);
      allEvents.push(...cached);
      continue;
    }

    const postTexts = formatPostsForLLM(profile.posts);

    const events = await extractEvents(
      postTexts,
      `Instagram @${profile.handle}`,
      { pageTitle: `Instagram: @${profile.handle}`, h1: profile.handle }
    );
    console.log(`  @${profile.handle} — ${events.length} events extracted`);

    // OCR flyer images for events missing date or venue
    const needsOcr = events.filter((e) => !e.date || !e.venue);
    if (needsOcr.length) {
      console.log(`    → OCR pass for ${needsOcr.length} incomplete event(s)`);
      for (const e of needsOcr) {
        try {
          const post = profile.posts.find(
            (p) => p.url === e.url || (p.caption && p.caption.includes(e.name))
          );
          if (!post?.displayUrl) continue;
          const patched = await ocrEventImage(post.displayUrl, e);
          for (const [key, val] of Object.entries(patched)) {
            if (val && !e[key]) e[key] = val;
          }
          if (Object.keys(patched).some((k) => patched[k])) {
            console.log(`      ✓ ${e.name}: filled ${Object.keys(patched).filter((k) => patched[k]).join(", ")}`);
          }
        } catch (err) {
          console.log(`      ✗ OCR failed for "${e.name}": ${err.message.slice(0, 80)}`);
        }
      }
    }

    // Fallback: scrape URLs from captions for still-incomplete events
    const stillIncomplete = events.filter((e) => !e.date || !e.venue);
    if (stillIncomplete.length) {
      for (const e of stillIncomplete) {
        try {
          const post = profile.posts.find(
            (p) => p.url === e.url || (p.caption && p.caption.includes(e.name))
          );
          if (!post?.caption) continue;
          const urlMatch = post.caption.match(/https?:\/\/[^\s)]+|(?:www\.)?[a-z0-9-]+\.[a-z]{2,}(?:\/[^\s)]*)?/i);
          if (!urlMatch) continue;
          const siteUrl = urlMatch[0].startsWith("http") ? urlMatch[0] : `https://${urlMatch[0]}`;
          console.log(`    → Fetching linked site for "${e.name}": ${siteUrl}`);
          const html = await fetchPage(siteUrl);
          if (!html) continue;
          const { body } = parseHtml(html, siteUrl);
          const siteEvents = await extractEvents(body.slice(0, 20_000), `${siteUrl} (via Instagram)`, {});
          const match = siteEvents.find((se) =>
            se.name && e.name && se.name.toLowerCase().includes(e.name.toLowerCase().split(" ")[0])
          ) || siteEvents[0];
          if (match) {
            if (match.date && !e.date) { e.date = match.date; console.log(`      ✓ filled date: ${match.date}`); }
            if (match.time && !e.time) { e.time = match.time; console.log(`      ✓ filled time: ${match.time}`); }
            if (match.venue && !e.venue) { e.venue = match.venue; console.log(`      ✓ filled venue: ${match.venue}`); }
            if (match.town && !e.town) { e.town = match.town; console.log(`      ✓ filled town: ${match.town}`); }
            if (match.description && !e.description) e.description = match.description;
          }
        } catch (err) {
          console.log(`      ✗ Site scrape failed for "${e.name}": ${err.message.slice(0, 80)}`);
        }
      }
    }

    const tagged = events.map((e) => {
      if (!e.town && profile.town) e.town = profile.town;
      return {
        ...e,
        source: `Instagram @${profile.handle}`,
        sourceUrl: `https://www.instagram.com/${profile.handle}/`,
      };
    });

    setCache(cacheKey, tagged);
    allEvents.push(...tagged);
  }

  saveScrapeCache();
  console.log(`  ✓ ${allEvents.length} total Instagram events`);
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
      } else if (source.type === "tockify") {
        events = await handleTockify(source);
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

  // Process Instagram profiles
  try {
    const igEvents = await handleInstagram();
    allEvents.push(...igEvents);
  } catch (err) {
    console.error(`  ✗ Error processing Instagram: ${err.message}`);
  }

  // Deduplicate
  console.log(`\n--- Deduplication ---`);
  console.log(`Before: ${allEvents.length} events`);
  const deduped = deduplicateEvents(allEvents);
  console.log(`After: ${deduped.length} events`);

  // Resolve missing towns (and correct address-as-venue-name) via LLM
  const needsTown = deduped.filter((e) => !e.town && e.venue);
  if (needsTown.length) {
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
  }

  // Normalize town names: strip state suffixes like ", NY" or " New York"
  for (const e of deduped) {
    if (e.town) {
      e.town = e.town.replace(/,?\s*(NY|New York|USA)$/i, "").trim();
    }
  }

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

  await closeBrowser();

  console.log(`\n--- Done ---`);
  console.log(`Saved ${deduped.length} events to output/events.md and output/events.json`);
  console.log(`\n${markdown.slice(0, 2000)}...`);
}

main().catch(console.error);
