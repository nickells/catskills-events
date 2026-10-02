import { ApifyClient } from "apify-client";
import { readFileSync } from "node:fs";

const POST_SCRAPER_ACTOR = "apify/instagram-post-scraper";
const GRAPH_URL = "https://graph.facebook.com/v23.0";
const DAY_MS = 24 * 60 * 60 * 1000;
const POST_WINDOW_MS = 30 * DAY_MS;
const META_MEDIA_LIMIT = 12;
const META_CONCURRENCY = 4;
const META_NOT_BUSINESS_SUBCODE = 2207013;
const META_RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
const META_EXPIRY_WARNING_DAYS = 14;
// Hard ceiling per fallback run; the free Apify plan stops at $5/month.
const APIFY_MAX_CHARGE_USD = 0.25;

function readKeyFile(name) {
  try {
    const raw = readFileSync(new URL(`../${name}`, import.meta.url), "utf8").trim();
    return raw.includes("=") ? raw.slice(raw.indexOf("=") + 1).trim() : raw;
  } catch {
    return undefined;
  }
}

export const getApifyToken = () => process.env.APIFY_TOKEN || readKeyFile("apifey_key");
export const getMetaPageToken = () => process.env.META_PAGE_TOKEN || readKeyFile("meta_key");

// --- Post storage ---
// Raw posts are kept for 30 days so each source only needs posts since its last fetch.

const postsKey = (handle) => `instagram-posts:${handle}`;

export function mergePosts(stored = [], fresh = [], now = Date.now()) {
  const byId = new Map();
  for (const post of [...stored, ...fresh]) byId.set(post.id || post.url, post);
  return [...byId.values()]
    .filter((post) => !post.timestamp || now - Date.parse(post.timestamp) < POST_WINDOW_MS)
    .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
}

const normalizeMetaPost = (media) => ({
  id: media.id,
  caption: media.caption || "",
  timestamp: new Date(media.timestamp).toISOString(),
  url: media.permalink,
  displayUrl: media.media_type === "VIDEO" ? media.thumbnail_url || media.media_url : media.media_url,
});

const normalizeApifyPost = (post) => ({
  id: post.id || post.shortCode,
  caption: post.caption || "",
  timestamp: post.timestamp,
  url: post.url,
  displayUrl: post.displayUrl,
  alt: post.alt,
  locationName: post.locationName,
});

// --- Meta Business Discovery (free, business/creator accounts only) ---

async function graph(path, params, token, fetchImpl) {
  const url = new URL(GRAPH_URL + path);
  for (const [key, value] of Object.entries({ ...params, access_token: token })) url.searchParams.set(key, value);
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  const body = await response.json();
  if (body.error) {
    const error = new Error(body.error.error_user_msg || body.error.message);
    Object.assign(error, { code: body.error.code, subcode: body.error.error_subcode });
    throw error;
  }
  return body;
}

async function connectMeta(token, { fetchImpl, now, log }) {
  const { data } = await graph("/debug_token", { input_token: token }, token, fetchImpl);
  if (!data?.is_valid) throw new Error("META_PAGE_TOKEN is not valid");
  // Page tokens never expire, but Meta revokes data access ~90 days after the last login.
  const expiresAt = data.data_access_expires_at * 1000;
  if (expiresAt && expiresAt - now < META_EXPIRY_WARNING_DAYS * DAY_MS) {
    const date = new Date(expiresAt).toISOString().slice(0, 10);
    log(`  ⚠ Meta data access expires ${date}: regenerate the token in Graph API Explorer to renew it`);
  }
  const page = await graph("/me", { fields: "instagram_business_account" }, token, fetchImpl);
  if (!page.instagram_business_account) throw new Error("META_PAGE_TOKEN's Page has no linked Instagram account");
  return page.instagram_business_account.id;
}

async function fetchMetaPosts(handle, igUserId, token, fetchImpl) {
  const fields = `business_discovery.username(${handle}){media.limit(${META_MEDIA_LIMIT})`
    + "{id,caption,timestamp,permalink,media_url,thumbnail_url,media_type}}";
  const body = await graph(`/${igUserId}`, { fields }, token, fetchImpl);
  return (body.business_discovery.media?.data || []).map(normalizeMetaPost);
}

async function fetchFromMeta(sources, token, { fetchImpl, now, log }) {
  const fetched = new Map();
  const fallback = [];
  let igUserId;
  try {
    igUserId = await connectMeta(token, { fetchImpl, now, log });
  } catch (error) {
    log(`  ✗ Meta unavailable (${error.message}); using Apify for all profiles`);
    return { fetched, fallback: [...sources] };
  }

  const queue = [...sources];
  let rateLimited = false;
  const worker = async () => {
    for (let source = queue.shift(); source; source = queue.shift()) {
      // Remaining profiles reuse cached events instead of spending Apify credit.
      if (rateLimited) continue;
      try {
        fetched.set(source.handle, await fetchMetaPosts(source.handle, igUserId, token, fetchImpl));
      } catch (error) {
        if (META_RATE_LIMIT_CODES.has(error.code)) {
          rateLimited = true;
          log("  ✗ Meta rate limit reached; remaining profiles keep cached events");
        } else {
          if (error.subcode !== META_NOT_BUSINESS_SUBCODE) log(`    @${source.handle} — Meta error: ${error.message}`);
          fallback.push(source);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: META_CONCURRENCY }, worker));
  return { fetched, fallback };
}

// --- Apify post scraper (paid per post; personal accounts and Meta failures) ---

async function runApifyPostScraper(input, token) {
  const client = new ApifyClient({ token });
  const run = await client.actor(POST_SCRAPER_ACTOR).call(input, { maxTotalChargeUsd: APIFY_MAX_CHARGE_USD });
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return items;
}

async function fetchFromApify(sources, cache, { token, now, log, runApify }) {
  const fetched = new Map();
  if (!sources.length) return fetched;
  if (!token) {
    log(`  ✗ APIFY_TOKEN not set; ${sources.length} profile(s) keep cached events`);
    return fetched;
  }
  // One date filter applies to the whole run, so start from the stalest profile.
  const since = Math.min(...sources.map((source) => cache[postsKey(source.handle)]?.events?.fetchedAt ?? now - POST_WINDOW_MS));
  log(`  Apify post scraper: ${sources.length} profile(s), posts since ${new Date(since).toISOString().slice(0, 10)}`);
  const items = await runApify({
    username: sources.map((source) => source.handle),
    onlyPostsNewerThan: new Date(since).toISOString(),
    skipPinnedPosts: true,
    resultsLimit: 50,
  }, token);

  const handles = new Set(sources.map((source) => source.handle.toLowerCase()));
  const handleFor = (item) => {
    const fromInput = item.inputUrl?.match(/instagram\.com\/([^/?#]+)/)?.[1]?.toLowerCase();
    return handles.has(fromInput) ? fromInput : item.ownerUsername?.toLowerCase();
  };
  const notFound = new Set();
  for (const item of items) {
    const handle = handleFor(item);
    if (!handles.has(handle)) continue;
    if (item.error === "not_found") notFound.add(handle);
    // "no_items" means the profile loaded but had no posts in the window.
    if (!fetched.has(handle) && item.error !== "not_found") fetched.set(handle, []);
    if (!item.error && item.timestamp) fetched.get(handle).push(normalizeApifyPost(item));
  }
  for (const handle of notFound) {
    log(`    @${handle} — not found on Instagram`);
    // Mark as checked so a dead handle doesn't force a 30-day lookback on every run.
    const source = sources.find((s) => s.handle.toLowerCase() === handle);
    cache[postsKey(source.handle)] = { ts: now, events: { fetchedAt: now, posts: [], notFound: true } };
  }
  return fetched;
}

// --- Entry point ---

export async function fetchInstagramProfiles(sources, cache, {
  fetchImpl = fetch,
  runApify = runApifyPostScraper,
  metaToken = getMetaPageToken(),
  apifyToken = getApifyToken(),
  now = Date.now(),
  log = console.log,
} = {}) {
  let fetched = new Map();
  let fallback = [...sources];
  if (metaToken) ({ fetched, fallback } = await fetchFromMeta(sources, metaToken, { fetchImpl, now, log }));
  else log("  META_PAGE_TOKEN not set; using Apify for all profiles");
  log(`  Meta: ${fetched.size} profiles; Apify fallback: ${fallback.length}`);

  try {
    for (const [handle, posts] of await fetchFromApify(fallback, cache, { token: apifyToken, now, log, runApify })) {
      const source = fallback.find((s) => s.handle.toLowerCase() === handle);
      fetched.set(source.handle, posts);
    }
  } catch (error) {
    log(`  ✗ Apify post scraper failed: ${error.message}`);
  }

  return sources.map((source) => {
    const stored = cache[postsKey(source.handle)]?.events;
    if (!fetched.has(source.handle)) return { ...source, posts: stored?.posts || [], available: false };
    const posts = mergePosts(stored?.posts, fetched.get(source.handle), now);
    cache[postsKey(source.handle)] = { ts: now, events: { fetchedAt: now, posts } };
    return { ...source, posts, available: true };
  });
}

// --- Change detection ---

function postFingerprint(posts) {
  return posts.map((post) => post.id || post.url || post.timestamp || "").join("|");
}

// Compares against the last extraction without saving, so a failed extraction is retried next run.
export function checkInstagramPoll(cache, profile) {
  const previous = cache[`instagram-poll:${profile.handle}`]?.events;
  const fingerprint = postFingerprint(profile.posts);
  return { changed: previous?.fingerprint !== fingerprint, state: { fingerprint } };
}

export function recordInstagramPoll(cache, profile, now = Date.now()) {
  const { state, ...poll } = checkInstagramPoll(cache, profile);
  cache[`instagram-poll:${profile.handle}`] = { ts: now, events: state };
  return poll;
}

export function formatPostsForLLM(posts) {
  return posts
    .map((p, i) => {
      const parts = [`--- Post ${i + 1} ---`];
      if (p.url) parts.push(`Post URL: ${p.url}`);
      if (p.timestamp) parts.push(`Posted: ${new Date(p.timestamp).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`);
      if (p.caption) parts.push(p.caption);
      if (p.alt && p.alt.length > 30) parts.push(`[Image: ${p.alt}]`);
      if (p.locationName) parts.push(`Location: ${p.locationName}`);
      return parts.join("\n");
    })
    .join("\n\n");
}
