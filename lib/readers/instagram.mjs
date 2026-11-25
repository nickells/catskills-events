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
// post named none, for fresh and cached events alike. An account with no venue of its own
// (an organization running events around the region) can't place a post that names a venue:
// @catskillcenter's walk at Platte Clove Preserve landed in Arkville, 25 miles off. Those
// are left for the town resolver, which looks the venue up, with the account's town kept only
// as a fallback. Earlier runs cached the account's town as the post's own (and a post at the
// account's home could name it too), so a matching town is handed back the same way.
export function withAccountTown(events, source) {
  for (const e of events || []) {
    cleanEvent(e);
    const elsewhere = e.venue && !source.venue;
    if (elsewhere && source.town && (!e.town || e.town === source.town)) {
      e.town = null;
      e._fallbackTown = source.town;
    }
    if (!e.town && source.town && !elsewhere) e.town = source.town;
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

// Words too common in event names to tie two events together ("Elton John Tribute Concert"
// and "Holiday Concert" share only "concert").
const GENERIC_NAME_WORDS = new Set([
  "the", "and", "with", "for", "from", "featuring", "presents", "concert", "night", "event",
  "show", "live", "music", "performance",
]);
const MIN_NAME_WORD_LENGTH = 3; // Drops "a", "of", "dr", "mr"
const MIN_SHARED_NAME_WORDS = 2;

const nameWords = (name) => new Set(String(name || "").toLowerCase().split(/[^\p{L}\p{N}]+/u)
  .filter((word) => word.length >= MIN_NAME_WORD_LENGTH && !GENERIC_NAME_WORDS.has(word)));

// The linked site's event that is this one: the one sharing the most distinctive name words,
// with at least two shared (or all of them, for a one-word name like "WILDWOOD"). A caption's
// link is often just the account's homepage, whose first event is some other show: borrowing its
// date put a month of old Halloween posts on one Saturday in November.
export function matchSiteEvent(event, siteEvents) {
  const words = nameWords(event.name);
  const needed = Math.min(MIN_SHARED_NAME_WORDS, words.size);
  if (!needed) return null;
  let best = null;
  let bestShared = 0;
  for (const siteEvent of siteEvents) {
    const shared = [...nameWords(siteEvent.name)].filter((word) => words.has(word)).length;
    if (shared >= needed && shared > bestShared) [best, bestShared] = [siteEvent, shared];
  }
  return best;
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
      const match = matchSiteEvent(e, siteEvents);
      if (!match) continue;
      const { date, time, venue, town, description } = match;
      const filled = fillMissing(e, { date, time, venue, town, description });
      if (filled.length) console.log(`      ✓ ${e.name}: filled ${filled.join(", ")} from linked site`);
    } catch (err) {
      console.log(`      ✗ Filling "${e.name}" failed: ${err.message.slice(0, 80)}`);
    }
  }
}

// Notes when each event's post went up, so an undated event can age out (see dropPast).
export function withPostDates(events, posts) {
  for (const e of events || []) {
    const post = !e._postedAt && findPostForEvent(e, posts || []);
    if (post?.timestamp) e._postedAt = post.timestamp;
  }
  return events;
}

// A profile's events: cached while its recent posts are unchanged, else extracted afresh.
async function readProfile(profile, ctx) {
  const { cache } = ctx;
  const cached = withPostDates(withAccountTown(cache.get(cacheKey(profile.handle), CACHE_TTL_MS), profile), profile.posts);
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

  const tagged = withPostDates(withAccountTown(events, profile), posts).map((e) => ({
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
