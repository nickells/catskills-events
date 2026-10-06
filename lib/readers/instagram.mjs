import { fetchPage } from "../fetch.mjs";
import { extractEvents, ocrEventImage, locateAccounts, extractMentionedUsernames } from "../openai.mjs";
import { cleanEvent } from "../clean.mjs";
import { parseHtml } from "../html.mjs";
import { mentionsForPosts, resolveTaggedPlaces, taggedPlaceLines } from "../tagged.mjs";
import { clearUnanchoredDates, findPostForEvent, resolveInstagramRelativeDates } from "../relative-date.mjs";
import { detectTextAtUrl } from "../google-vision.mjs";
import { checkInstagramPoll, recordInstagramPoll, extractPostEvents, prunePostEvents, withFlyerText } from "../instagram.mjs";

const CACHE_TTL_MS = 8 * 24 * 60 * 60 * 1000; // Rides out several days of Instagram fetch failures
// New tagged-account lookups per run, on top of the daily profile fetches, within Meta's rate limit.
const TAGGED_LOOKUPS_PER_RUN = 80;
const CAPTION_URL_RE = /https?:\/\/[^\s)]+|(?:www\.)?[a-z0-9-]+\.[a-z]{2,}(?:\/[^\s)]*)?/i;

const cacheKey = (handle) => `instagram:${handle}`;

// Cleans "null" text from an account's events and fills in the account's town where a
// post named none, for fresh and cached events alike.
function withAccountTown(events, source) {
  for (const e of events || []) {
    cleanEvent(e);
    if (!e.town && source.town) e.town = source.town;
  }
  return events;
}

// Fills the event's empty fields from patch; returns the names of the fields filled.
function fillMissing(event, patch) {
  const filled = Object.keys(patch).filter((key) => patch[key] && !event[key]);
  for (const key of filled) event[key] = patch[key];
  return filled;
}

// Attaches where each post's tagged venues are ("@crcinarkville = Catskill Recreation Center,
// Arkville, NY") so extraction places an event at the tagged venue, not this account's town.
async function withTaggedPlaces(profile, { cache, lookupProfile, known, budget }) {
  try {
    const mentions = await mentionsForPosts(profile.posts, { extractMentions: extractMentionedUsernames, cache: cache.data });
    const handles = [...new Set([...mentions.values()].flat())].filter((h) => h !== profile.handle.toLowerCase());
    const places = await resolveTaggedPlaces(handles, {
      known, lookupProfile, askPlaces: locateAccounts, cache: cache.data, budget, log: console.log,
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

// Completes events still missing a date or venue: OCR the flyer when extraction didn't see it,
// then read the site the caption links to.
async function fillIncomplete(events, posts) {
  const incomplete = (e) => !e.date || !e.venue;
  for (const e of events.filter(incomplete)) {
    const post = findPostForEvent(e, posts);
    try {
      if (post?.displayUrl && post.flyerText == null) {
        const filled = fillMissing(e, await ocrEventImage(post.displayUrl, e));
        if (filled.length) console.log(`      ✓ ${e.name}: filled ${filled.join(", ")} from flyer`);
      }
      const link = incomplete(e) && post?.caption?.match(CAPTION_URL_RE)?.[0];
      if (!link) continue;
      const siteUrl = link.startsWith("http") ? link : `https://${link}`;
      console.log(`    → Fetching linked site for "${e.name}": ${siteUrl}`);
      const html = await fetchPage(siteUrl);
      if (!html) continue;
      const siteEvents = await extractEvents(parseHtml(html, siteUrl).body.slice(0, 20_000), `${siteUrl} (via Instagram)`, {});
      const firstWord = e.name?.toLowerCase().split(" ")[0];
      const match = siteEvents.find((se) => firstWord && se.name?.toLowerCase().includes(firstWord)) || siteEvents[0];
      if (!match) continue;
      const { date, time, venue, town, description } = match;
      const filled = fillMissing(e, { date, time, venue, town, description });
      if (filled.length) console.log(`      ✓ ${e.name}: filled ${filled.join(", ")} from linked site`);
    } catch (err) {
      console.log(`      ✗ Filling "${e.name}" failed: ${err.message.slice(0, 80)}`);
    }
  }
}

// A profile's events: cached while its recent posts are unchanged, else extracted afresh.
async function readProfile(profile, ctx) {
  const { cache } = ctx;
  const cached = withAccountTown(cache.get(cacheKey(profile.handle), CACHE_TTL_MS), profile);
  if (!profile.available) return cached || [];

  const poll = checkInstagramPoll(cache.data, profile);
  if (!profile.posts.length || (cached && !poll.changed)) {
    recordInstagramPoll(cache.data, profile);
    if (cached && profile.posts.length) console.log(`  @${profile.handle} — ${cached.length} events (no new posts)`);
    return cached || [];
  }

  const placed = (await withTaggedPlaces(profile, ctx))
    .map((post) => (profile.venue ? { ...post, accountVenue: profile.venue } : post));
  const posts = await withFlyerText(placed, { ocr: (url) => detectTextAtUrl(url), cache: cache.data, log: console.log });
  const { events, extracted, failed } = await extractPostEvents(
    posts,
    (text) => extractEvents(text, `Instagram @${profile.handle}`, { pageTitle: `Instagram: @${profile.handle}`, h1: profile.handle }),
    cache.data,
  );
  events.forEach(cleanEvent);
  console.log(`  @${profile.handle} — ${events.length} events from ${profile.posts.length} posts (${extracted} extracted${failed ? `, ${failed} failed` : ""})`);

  // Interpret relative phrases against the post timestamp, then do calendar math in code.
  const { anchored } = await resolveInstagramRelativeDates(events, posts, cache.data);
  clearUnanchoredDates(events, posts, anchored);
  await fillIncomplete(events, posts);

  const tagged = withAccountTown(events, profile).map((e) => ({
    ...e,
    source: `Instagram @${profile.handle}`,
    sourceUrl: `https://www.instagram.com/${profile.handle}/`,
  }));
  cache.set(cacheKey(profile.handle), tagged);
  // Record the poll only once every post is extracted, so failed posts are retried.
  if (!failed) recordInstagramPoll(cache.data, profile);
  return tagged;
}

// Events from every fetched profile. Without profiles (the fetch failed), each source falls
// back to its cached events.
export async function readInstagram(profiles, sources, { cache, lookupProfile }) {
  if (!profiles) {
    return sources.flatMap((source) => withAccountTown(cache.get(cacheKey(source.handle), CACHE_TTL_MS), source) || []);
  }
  console.log(`\n[Instagram] ${profiles.filter((p) => p.available).length}/${profiles.length} profiles fetched`);
  const ctx = {
    cache,
    lookupProfile,
    known: Object.fromEntries(sources.filter((s) => s.town).map((s) => [s.handle.toLowerCase(), s.town])),
    budget: { remaining: TAGGED_LOOKUPS_PER_RUN },
  };
  const events = [];
  for (const profile of profiles) {
    try {
      events.push(...await readProfile(profile, ctx));
    } catch (err) {
      console.error(`  ✗ Error processing @${profile.handle}: ${err.message}`);
      events.push(...withAccountTown(cache.get(cacheKey(profile.handle), CACHE_TTL_MS), profile) || []);
    }
  }
  prunePostEvents(cache.data);
  cache.save();
  console.log(`  ✓ ${events.length} total Instagram events`);
  return events;
}
