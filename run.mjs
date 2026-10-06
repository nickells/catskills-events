import "dotenv/config";
import { writeFileSync, mkdirSync } from "fs";
import { fetchPage, closeBrowser } from "./lib/fetch.mjs";
import { openCache } from "./lib/cache.mjs";
import { formatEvents, formatJSON } from "./lib/format.mjs";
import { WEB_SOURCES, INSTAGRAM_SOURCES, VENUE_CALENDARS } from "./lib/sources.mjs";
import { readSources, readInstagram } from "./lib/readers/index.mjs";
import { enrichEvents } from "./lib/enrich.mjs";
import { discoverInstagramSources, loadDiscoveredSources, saveDiscoveredSources } from "./lib/discover.mjs";
import { findOrganizerLeads, organizerSite } from "./lib/leads.mjs";
import { discoverCalendars } from "./lib/calendars.mjs";
import { attachFlyers, postImages } from "./lib/flyers.mjs";
import { createMetaProfileLookup, fetchInstagramProfiles } from "./lib/instagram.mjs";

const OUTPUT_DIR = "./output";

// Hand-picked sources first, then ones discovery found on earlier runs that aren't among them.
function withDiscovered(handPicked, discovered, key) {
  const known = new Set(handPicked.map(key));
  return [...handPicked, ...discovered.filter((source) => !known.has(key(source)))];
}

// Vets accounts that sources @mention or organizers' sites link to, and looks for calendars on
// those sites and Instagram accounts' websites. Finds are read from the next run on.
async function discover({ listed, profiles, instagramSources, registry, cache, lookupProfile }) {
  console.log(`\n--- Instagram Discovery ---`);
  let organizerSites = [];
  try {
    const organizers = await findOrganizerLeads(listed, { cache: cache.data, fetchPage });
    organizerSites = organizers.sites;
    if (!lookupProfile) throw new Error("no Meta profile lookup");
    await discoverInstagramSources({
      sources: instagramSources,
      leads: organizers.leads,
      cache: cache.data,
      registry,
      lookupProfile,
    });
    saveDiscoveredSources(registry);
  } catch (err) {
    console.error(`  ✗ Error discovering Instagram sources: ${err.message}`);
  }

  console.log(`\n--- Calendar Discovery ---`);
  try {
    const hostOf = (url) => new URL(url).hostname.replace(/^www\./, "");
    const skipHosts = [...WEB_SOURCES.flatMap((source) => source.urls || []), ...VENUE_CALENDARS.map((c) => c.url)].map(hostOf);
    const sites = [
      ...(profiles || []).filter((p) => p.website && organizerSite(p.website)).map((p) => ({
        site: organizerSite(p.website), venue: p.venue, town: p.town, via: `@${p.handle}`,
      })),
      ...organizerSites.map(({ site, town }) => ({ site, town, via: "event link" })),
    ];
    await discoverCalendars({ sites, registry, cache: cache.data, fetchPage, skipHosts });
    saveDiscoveredSources(registry);
  } catch (err) {
    console.error(`  ✗ Error discovering calendars: ${err.message}`);
  }
}

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const cache = openCache(`${OUTPUT_DIR}/scrape-cache.json`);
  console.log("=== Catskills Event Aggregator ===\n");

  const registry = loadDiscoveredSources();
  const handle = (source) => source.handle.toLowerCase();
  const instagramSources = withDiscovered(INSTAGRAM_SOURCES, registry.accepted, handle);
  const webSources = [
    ...WEB_SOURCES,
    ...withDiscovered(VENUE_CALENDARS, registry.calendars, (c) => c.url).map((c) => ({ ...c, type: "venue-calendar" })),
  ];

  // Fetch every Instagram profile daily (Meta, with Apify fallback) in parallel with web sources.
  console.log("[Instagram] Fetching profiles in the background...");
  const instagramFetch = fetchInstagramProfiles(instagramSources, cache.data).catch((err) => {
    console.error(`  ✗ Error fetching Instagram: ${err.message}`);
    return null;
  });
  const lookupProfile = await createMetaProfileLookup().catch((err) => {
    console.error(`  ✗ Meta profile lookup unavailable: ${err.message}`);
    return null;
  });

  const listed = await readSources(webSources, { cache });
  const profiles = await instagramFetch;
  const instagram = await readInstagram(profiles, instagramSources, { cache, lookupProfile });

  // Listings link to organizers' own sites, which discovery follows.
  await discover({ listed, profiles, instagramSources, registry, cache, lookupProfile });

  const events = await enrichEvents([...listed, ...instagram], { cache });
  const json = formatJSON(events);

  // Flyer images for the flyer board, kept in output/flyers between runs
  console.log(`\n--- Flyers ---`);
  try {
    await attachFlyers(json, postImages(cache.data));
  } catch (err) {
    console.error(`  ✗ Error attaching flyers: ${err.message}`);
  }

  const markdown = formatEvents(events);
  writeFileSync(`${OUTPUT_DIR}/events.md`, markdown);
  writeFileSync(`${OUTPUT_DIR}/events.json`, JSON.stringify(json, null, 2));
  await closeBrowser();

  console.log(`\n--- Done ---`);
  console.log(`Saved ${events.length} events to output/events.md and output/events.json`);
  console.log(`\n${markdown.slice(0, 2000)}...`);
}

main().catch(console.error);
