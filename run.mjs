import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import * as cheerio from "cheerio";
import { fetchPage, fetchPageWithBrowser, closeBrowser } from "./lib/fetch.mjs";
import { extractEvents, resolveVenueTowns, ocrEventImage, locateFromPage, locateFromKnowledge, locateAccounts, extractMentionedUsernames } from "./lib/openai.mjs";
import { deduplicateEvents } from "./lib/dedup.mjs";
import { filterOutsideNewYork } from "./lib/location.mjs";
import { categorizeEvents } from "./lib/categorize.mjs";
import { formatEvents, formatJSON } from "./lib/format.mjs";
import { loadGeoCache, geocodeEvents } from "./lib/geocode.mjs";
import { locateEvents } from "./lib/locate.mjs";
import { cleanEvent } from "./lib/clean.mjs";
import { mentionsForPosts, resolveTaggedPlaces, taggedPlaceLines } from "./lib/tagged.mjs";
import { WEB_SOURCES, INSTAGRAM_SOURCES } from "./lib/sources.mjs";
import { findPostForEvent, resolveInstagramRelativeDates } from "./lib/relative-date.mjs";
import { discoverInstagramSources, loadDiscoveredSources, saveDiscoveredSources } from "./lib/discover.mjs";
import {
  createMetaProfileLookup,
  fetchInstagramProfiles,
  checkInstagramPoll,
  recordInstagramPoll,
  extractPostEvents,
  prunePostEvents,
} from "./lib/instagram.mjs";

const KNOWN_TOWNS = new Set(
  Object.keys(JSON.parse(readFileSync("./lib/town-coords.json", "utf-8")))
);


const OUTPUT_DIR = "./output";
const SCRAPE_CACHE_FILE = `${OUTPUT_DIR}/scrape-cache.json`;
const CACHE_TTL_MS = 20 * 60 * 60 * 1000; // 20 hours
const IG_CACHE_TTL_MS = 8 * 24 * 60 * 60 * 1000; // Rides out several days of Instagram fetch failures

let scrapeCache = {};

function loadScrapeCache() {
  if (existsSync(SCRAPE_CACHE_FILE)) {
    scrapeCache = JSON.parse(readFileSync(SCRAPE_CACHE_FILE, "utf-8"));
  }
}

function saveScrapeCache() {
  writeFileSync(SCRAPE_CACHE_FILE, JSON.stringify(scrapeCache, null, 2));
}

function getCached(url, ttl = CACHE_TTL_MS) {
  const entry = scrapeCache[url];
  if (!entry) return null;
  if (Date.now() - entry.ts > ttl) return null;
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

      // Extract venue from title if place field is empty (e.g. "Locals Night at Wayside Cider")
      const titleText = c.summary?.text || "Unknown Event";
      let venue = c.place || null;
      if (!venue) {
        const atMatch = titleText.match(/\bat\s+(.+)/i);
        if (atMatch) venue = atMatch[1].trim();
      }

      return {
        name: titleText,
        date,
        time: timeStr,
        venue,
        town,
        description: c.description?.text?.slice(0, 200) || null,
        url: c.customButtonLink || `https://tockify.com/${source.tockifyCalendar}/detail/${e.eid?.uid}`,
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

// Cleans "null" text from an account's events and fills in the account's town where a
// post named none, for fresh and cached events alike.
function withAccountTown(events, source) {
  for (const e of events || []) {
    cleanEvent(e);
    if (!e.town && source.town) e.town = source.town;
  }
  return events;
}

// New tagged-account lookups per run, on top of the daily profile fetches, within Meta's rate limit.
const TAGGED_LOOKUPS_PER_RUN = 80;

// Attaches where each post's tagged venues are ("@crcinarkville = Catskill Recreation Center,
// Arkville, NY") so extraction places an event at the tagged venue, not this account's town.
async function withTaggedPlaces(profile, { lookupProfile, known, budget }) {
  try {
    const mentions = await mentionsForPosts(profile.posts, { extractMentions: extractMentionedUsernames, cache: scrapeCache });
    const handles = [...new Set([...mentions.values()].flat())].filter((h) => h !== profile.handle.toLowerCase());
    const places = await resolveTaggedPlaces(handles, {
      known, lookupProfile, askPlaces: locateAccounts, cache: scrapeCache, budget, log: console.log,
    });
    return profile.posts.map((post) => {
      const lines = taggedPlaceLines(mentions.get(post) || [], places);
      return lines.length ? { ...post, taggedPlaces: lines } : post;
    });
  } catch (err) {
    console.log(`    ✗ Tagged places for @${profile.handle}: ${err.message.slice(0, 80)}`);
    return profile.posts;
  }
}

async function handleInstagram(profiles, tagging) {
  console.log(`\n[Instagram] ${profiles.filter((p) => p.available).length}/${profiles.length} profiles fetched`);
  const allEvents = [];

  for (const profile of profiles) {
    const cacheKey = `instagram:${profile.handle}`;
    const cached = withAccountTown(getCached(cacheKey, IG_CACHE_TTL_MS), profile);

    if (!profile.available) {
      if (cached) allEvents.push(...cached);
      continue;
    }

    const poll = checkInstagramPoll(scrapeCache, profile);

    if (!profile.posts.length) {
      recordInstagramPoll(scrapeCache, profile);
      if (cached) allEvents.push(...cached);
      continue;
    }

    // An unchanged set of recent posts doesn't need re-extracting.
    if (cached && !poll.changed) {
      recordInstagramPoll(scrapeCache, profile);
      console.log(`  @${profile.handle} — ${cached.length} events (no new posts)`);
      allEvents.push(...cached);
      continue;
    }

    const posts = await withTaggedPlaces(profile, tagging);
    const { events, extracted, failed } = await extractPostEvents(
      posts,
      (text) => extractEvents(text, `Instagram @${profile.handle}`, { pageTitle: `Instagram: @${profile.handle}`, h1: profile.handle }),
      scrapeCache
    );
    events.forEach(cleanEvent);
    console.log(`  @${profile.handle} — ${events.length} events from ${profile.posts.length} posts (${extracted} extracted${failed ? `, ${failed} failed` : ""})`);

    // Interpret relative phrases against the post timestamp, then do calendar math in code.
    await resolveInstagramRelativeDates(events, profile.posts, scrapeCache);

    // OCR flyer images for events missing date or venue
    const needsOcr = events.filter((e) => !e.date || !e.venue);
    if (needsOcr.length) {
      console.log(`    → OCR pass for ${needsOcr.length} incomplete event(s)`);
      for (const e of needsOcr) {
        try {
          const post = findPostForEvent(e, profile.posts);
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
          const post = findPostForEvent(e, profile.posts);
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

    const tagged = withAccountTown(events, profile).map((e) => {
      return {
        ...e,
        source: `Instagram @${profile.handle}`,
        sourceUrl: `https://www.instagram.com/${profile.handle}/`,
      };
    });

    setCache(cacheKey, tagged);
    // Record the poll only once every post is extracted, so failed posts are retried.
    if (!failed) recordInstagramPoll(scrapeCache, profile);
    allEvents.push(...tagged);
  }

  prunePostEvents(scrapeCache);
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

  // Hand-picked sources plus accounts found by discovery on earlier runs.
  const discovered = loadDiscoveredSources();
  const handPicked = new Set(INSTAGRAM_SOURCES.map((source) => source.handle.toLowerCase()));
  const instagramSources = [
    ...INSTAGRAM_SOURCES,
    ...discovered.accepted.filter((source) => !handPicked.has(source.handle.toLowerCase())),
  ];

  // Fetch every Instagram profile daily (Meta, with Apify fallback) in parallel with web sources.
  console.log("[Instagram] Fetching profiles in the background...");
  const instagramFetch = fetchInstagramProfiles(instagramSources, scrapeCache).catch((err) => {
    console.error(`  ✗ Error fetching Instagram: ${err.message}`);
    return null;
  });

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

  // Collect Instagram results; on failure every profile falls back to its cached events.
  let igEvents = null;
  try {
    const profiles = await instagramFetch;
    if (profiles) {
      igEvents = await handleInstagram(profiles, {
        lookupProfile: await createMetaProfileLookup().catch((err) => {
          console.error(`  ✗ Tagged places disabled: ${err.message}`);
          return null;
        }),
        known: Object.fromEntries(instagramSources.filter((s) => s.town).map((s) => [s.handle.toLowerCase(), s.town])),
        budget: { remaining: TAGGED_LOOKUPS_PER_RUN },
      });
    }
  } catch (err) {
    console.error(`  ✗ Error processing Instagram: ${err.message}`);
  }
  if (igEvents) allEvents.push(...igEvents);
  else {
    for (const source of instagramSources) {
      const cached = withAccountTown(getCached(`instagram:${source.handle}`, IG_CACHE_TTL_MS), source);
      if (cached) allEvents.push(...cached);
    }
  }

  // Vet accounts that sources @mention; accepted ones are fetched from the next run on.
  console.log(`\n--- Instagram Discovery ---`);
  try {
    await discoverInstagramSources({
      sources: instagramSources,
      cache: scrapeCache,
      registry: discovered,
      lookupProfile: await createMetaProfileLookup(),
    });
    saveDiscoveredSources(discovered);
  } catch (err) {
    console.error(`  ✗ Error discovering Instagram sources: ${err.message}`);
  }

  // Cached web-source events predate the cleanup in extractEvents.
  allEvents.forEach(cleanEvent);

  // Drop events clearly outside New York (e.g. same-named towns elsewhere)
  const { kept: nyEvents, dropped: outOfState } = filterOutsideNewYork(allEvents);
  if (outOfState.length) {
    console.log(`\n--- Location filter ---`);
    console.log(`Dropped ${outOfState.length} events outside New York`);
    for (const e of outOfState) console.log(`  ✗ ${e.name} @ ${e.venue}`);
  }

  // Deduplicate
  console.log(`\n--- Deduplication ---`);
  console.log(`Before: ${nyEvents.length} events`);
  const deduped = deduplicateEvents(nyEvents);
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

  const townCoords = JSON.parse(readFileSync("./lib/town-coords.json", "utf-8"));

  // Pin down upcoming events whose town can't be placed (missing, misspelled, several towns,
  // or not in town-coords) from their own page or the model's knowledge, so they get a distance.
  console.log(`\n--- Location ---`);
  const today = new Date().toISOString().slice(0, 10);
  const { checked, located } = await locateEvents(deduped.filter((e) => !e.date || e.date >= today), {
    townCoords,
    fetchText: async (url) => {
      const html = await fetchPage(url);
      return html ? parseHtml(html, url).body : null;
    },
    askPage: locateFromPage,
    askKnowledge: locateFromKnowledge,
    cache: scrapeCache,
    log: console.log,
  });
  console.log(`  Located ${located}/${checked} events`);
  saveScrapeCache();

  // Geocode events and add coordinates
  loadGeoCache();
  console.log(`\n--- Geocoding ---`);
  await geocodeEvents(deduped, townCoords);
  for (const e of deduped) {
    delete e._state;
    delete e._landmark;
  }

  // Classify only publishable events, after merging evidence from duplicate sources.
  console.log(`\n--- Event Categorization ---`);
  await categorizeEvents(formatJSON(deduped), scrapeCache);

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
