import test from "node:test";
import assert from "node:assert/strict";
import {
  checkInstagramPoll,
  extractPostEvents,
  fetchInstagramProfiles,
  mergeAccountDuplicates,
  mergePosts,
  prunePostEvents,
  recordInstagramPoll,
  formatPostsForLLM,
  withFlyerText,
} from "./instagram.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-02T12:00:00Z");
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const quiet = () => {};

// Fake Graph API: handles in `business` resolve, everything else is a personal account.
function fakeGraph(business, { expiresInDays = 90, calls = [] } = {}) {
  return async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + "?" + (u.searchParams.get("fields") || ""));
    const json = (body) => ({ json: async () => body });
    if (u.pathname.endsWith("/debug_token")) {
      return json({ data: { is_valid: true, data_access_expires_at: (NOW + expiresInDays * DAY) / 1000 } });
    }
    if (u.pathname.endsWith("/me")) return json({ instagram_business_account: { id: "ig-1" } });
    const handle = u.searchParams.get("fields").match(/username\(([^)]+)\)/)[1];
    if (!business[handle]) {
      return json({ error: { code: 110, error_subcode: 2207013, message: `cannot find ${handle}` } });
    }
    return json({ business_discovery: { media: { data: business[handle] } } });
  };
}

const metaMedia = (id, daysAgo) => ({
  id, caption: `post ${id}`, timestamp: iso(daysAgo), permalink: `https://instagram.com/p/${id}`,
  media_type: "IMAGE", media_url: `https://cdn/${id}.jpg`,
});

test("merging keeps one copy per post, newest first, within 30 days", () => {
  const stored = [{ id: "a", timestamp: iso(5) }, { id: "old", timestamp: iso(31) }];
  const fresh = [{ id: "b", timestamp: iso(1) }, { id: "a", timestamp: iso(5), caption: "edited" }];
  assert.deepEqual(mergePosts(stored, fresh, NOW), [
    { id: "b", timestamp: iso(1) },
    { id: "a", timestamp: iso(5), caption: "edited" },
  ]);
});

test("business accounts come from Meta; personal accounts fall back to Apify", async () => {
  const cache = {};
  let apifyInput;
  const profiles = await fetchInstagramProfiles(
    [{ handle: "venue", town: "Phoenicia" }, { handle: "personal" }],
    cache,
    {
      fetchImpl: fakeGraph({ venue: [metaMedia("v1", 1)] }),
      runApify: async (input) => {
        apifyInput = input;
        return [{ inputUrl: "https://www.instagram.com/personal", ownerUsername: "personal", id: "p1", timestamp: iso(2), caption: "hi", url: "u", displayUrl: "d" }];
      },
      metaToken: "meta", apifyToken: "apify", now: NOW, log: quiet,
    },
  );
  assert.deepEqual(apifyInput.username, ["personal"]);
  assert.equal(apifyInput.skipPinnedPosts, true);
  assert.equal(profiles[0].available, true);
  assert.equal(profiles[0].town, "Phoenicia");
  assert.deepEqual(profiles[0].posts[0], {
    id: "v1", caption: "post v1", timestamp: iso(1), url: "https://instagram.com/p/v1", displayUrl: "https://cdn/v1.jpg",
  });
  assert.equal(profiles[1].posts[0].id, "p1");
  assert.equal(cache["instagram-posts:personal"].events.fetchedAt, NOW);
});

test("Apify only asks for posts since the stalest fallback profile's last fetch", async () => {
  const cache = {
    "instagram-posts:a": { ts: 0, events: { fetchedAt: NOW - 1 * DAY, posts: [{ id: "kept", timestamp: iso(3) }] } },
    "instagram-posts:b": { ts: 0, events: { fetchedAt: NOW - 2 * DAY, posts: [] } },
  };
  let since;
  const profiles = await fetchInstagramProfiles([{ handle: "a" }, { handle: "b" }], cache, {
    runApify: async (input) => { since = input.onlyPostsNewerThan; return [{ inputUrl: "https://www.instagram.com/a/", error: "no_items" }]; },
    metaToken: null, apifyToken: "apify", now: NOW, log: quiet,
  });
  assert.equal(since, iso(2));
  // A profile with no new posts keeps its stored posts; one missing from results keeps its cache.
  assert.deepEqual(profiles.map((p) => [p.available, p.posts.length]), [[true, 1], [false, 0]]);
});

test("a not-found handle is marked checked so it stops forcing a 30-day lookback", async () => {
  const cache = {};
  await fetchInstagramProfiles([{ handle: "gone" }], cache, {
    runApify: async () => [{ inputUrl: "https://www.instagram.com/gone", error: "not_found" }],
    metaToken: null, apifyToken: "apify", now: NOW, log: quiet,
  });
  assert.equal(cache["instagram-posts:gone"].events.notFound, true);
  assert.equal(cache["instagram-posts:gone"].events.fetchedAt, NOW);
});

test("a Meta outage sends everything to Apify; without Apify, profiles keep caches", async () => {
  const brokenMeta = async () => ({ json: async () => ({ error: { code: 190, message: "token expired" } }) });
  let apifyUsers;
  await fetchInstagramProfiles([{ handle: "a" }, { handle: "b" }], {}, {
    fetchImpl: brokenMeta, runApify: async (input) => { apifyUsers = input.username; return []; },
    metaToken: "meta", apifyToken: "apify", now: NOW, log: quiet,
  });
  assert.deepEqual(apifyUsers, ["a", "b"]);

  const profiles = await fetchInstagramProfiles([{ handle: "a" }], {}, {
    fetchImpl: brokenMeta, runApify: () => assert.fail("Apify must not run without a token"),
    metaToken: "meta", apifyToken: null, now: NOW, log: quiet,
  });
  assert.equal(profiles[0].available, false);
});

test("warns two weeks before Meta data access expires", async () => {
  const logs = [];
  await fetchInstagramProfiles([], {}, {
    fetchImpl: fakeGraph({}, { expiresInDays: 10 }), metaToken: "meta", apifyToken: null, now: NOW,
    log: (line) => logs.push(line),
  });
  assert.ok(logs.some((line) => line.includes("Meta data access expires 2026-10-12")));
});

test("extraction is skipped until the set of recent posts changes", () => {
  const cache = {};
  const profile = { handle: "venue", posts: [{ id: "a" }] };
  assert.equal(checkInstagramPoll(cache, profile).changed, true);
  // Checking alone doesn't record, so a failed extraction is retried.
  assert.equal(checkInstagramPoll(cache, profile).changed, true);
  recordInstagramPoll(cache, profile, NOW);
  assert.equal(checkInstagramPoll(cache, profile).changed, false);
  assert.equal(checkInstagramPoll(cache, { ...profile, posts: [{ id: "b" }, { id: "a" }] }).changed, true);
});

test("each post is extracted on its own and cached until its text changes", async () => {
  const posts = [
    { id: "a", caption: "Trivia Night Oct 8", timestamp: iso(1) },
    { id: "b", caption: "Music Bingo Oct 9", timestamp: iso(2) },
  ];
  const prompts = [];
  const extract = async (text) => {
    prompts.push(text);
    const name = text.match(/(Trivia Night|Music Bingo)/)[1];
    return [{ name, date: name === "Trivia Night" ? "2026-10-08" : "2026-10-09", venue: "Taproom" }];
  };
  const cache = {};

  const first = await extractPostEvents(posts, extract, cache, { now: NOW });
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every((p) => p.split("--- Post").length === 2), "one post per prompt");
  assert.deepEqual(first.events.map((e) => e.name).sort(), ["Music Bingo", "Trivia Night"]);

  const second = await extractPostEvents(posts, extract, cache, { now: NOW });
  assert.equal(second.extracted, 0);
  assert.equal(second.events.length, 2);

  posts[1] = { ...posts[1], caption: "Music Bingo moved to Oct 9" };
  const third = await extractPostEvents(posts, extract, cache, { now: NOW });
  assert.equal(third.extracted, 1);
});

test("a failed post is reported and left uncached for a retry", async () => {
  const posts = [{ id: "a", caption: "x", timestamp: iso(1) }, { id: "b", caption: "y", timestamp: iso(1) }];
  const cache = {};
  const result = await extractPostEvents(posts, async (text) => {
    if (text.includes("\ny")) throw new Error("rate limited");
    return [];
  }, cache, { now: NOW });
  assert.equal(result.failed, 1);
  assert.deepEqual(Object.keys(cache), ["instagram-post:a"]);
});

test("cached events are copies, so later pipeline edits don't leak into the cache", async () => {
  const posts = [{ id: "a", caption: "x", timestamp: iso(1) }];
  const cache = {};
  const { events } = await extractPostEvents(posts, async () => [{ name: "Show", date: "2026-10-08" }], cache, { now: NOW });
  events[0].town = "Sidney";
  assert.equal(cache["instagram-post:a"].events[0].town, undefined);
});

test("the same event promoted in several posts is merged within an account", () => {
  const merged = mergeAccountDuplicates([
    { name: "margaret_glaspy", date: "2026-10-03", venue: "Assembly Kingston", time: "8:00 PM" },
    { name: "Margaret Glaspy live", date: "2026-10-03", venue: "Assembly Kingston", time: "8 PM", description: "Doors at 7." },
    { name: "Talking Heads music LIVE", date: "2026-10-02", venue: "Assembly Kingston", time: "8:00 PM" },
    { name: "Show with startmakingsenseband", date: "2026-10-02", venue: "Assembly Kingston", time: "8:00 PM" },
    { name: "Angelo De Augustine", date: "2026-10-07", venue: "Assembly Kingston", time: null },
    { name: "angelodeaugustine", date: "2026-10-07", venue: "Assembly Kingston", time: "7:30 PM" },
    { name: "Young Frankenstein", date: "2026-10-09", venue: "Phoenicia Playhouse", time: null },
    { name: "Young Frankenstein", date: "2026-10-09", venue: "The Phoenicia Playhouse", time: "7:00 PM" },
  ]);
  assert.equal(merged.length, 4);
  const glaspy = merged.find((e) => e.date === "2026-10-03");
  assert.equal(glaspy.name, "Margaret Glaspy live");
  assert.equal(glaspy.description, "Doors at 7.");
  assert.equal(merged.find((e) => e.date === "2026-10-07").time, "7:30 PM");
});

test("different events on the same day stay separate", () => {
  const merged = mergeAccountDuplicates([
    { name: "Young Frankenstein", date: "2026-10-12", venue: "Phoenicia Playhouse", time: "2:00 PM" },
    { name: "Young Frankenstein", date: "2026-10-12", venue: "Phoenicia Playhouse", time: "7:00 PM" },
    { name: "Little Falls Cheese Festival", date: "2026-10-03", venue: null, time: "10:00 AM" },
    { name: "Hamilton Farmers Market", date: "2026-10-03", venue: null, time: "10:00 AM" },
    { name: "Pumpkin Carving", date: "2026-10-03", venue: "The Farm", time: null },
    { name: "Hayrides", date: "2026-10-03", venue: "The Farm", time: null },
  ]);
  assert.equal(merged.length, 6);
});

test("per-post results are pruned a week after their post leaves the 30-day window", () => {
  const cache = {
    "instagram-post:old": { ts: NOW - 38 * DAY, events: [] },
    "instagram-post:new": { ts: NOW - 20 * DAY, events: [] },
    "instagram-poll:x": { ts: NOW - 90 * DAY, events: {} },
  };
  prunePostEvents(cache, NOW);
  assert.deepEqual(Object.keys(cache).sort(), ["instagram-poll:x", "instagram-post:new"]);
});

test("flyers are read once, only for posts whose caption names no date", async () => {
  const cache = {};
  const read = [];
  const ocr = async (url) => { read.push(url); return "OCTOBER 3-4\n10/3 – RIVALS NY"; };
  const posts = [
    { id: "a", caption: "Fall Festival is THIS WEEKEND", displayUrl: "img-a" },
    { id: "b", caption: "Jazz Night, Oct 9", displayUrl: "img-b" },
    { id: "c", caption: "Coming soon" },
  ];
  const withText = await withFlyerText(posts, { ocr, cache });
  assert.deepEqual(read, ["img-a"]);
  assert.equal(withText[0].flyerText, "OCTOBER 3-4\n10/3 – RIVALS NY");
  assert.equal(withText[1].flyerText, undefined);
  assert.match(formatPostsForLLM([withText[0]]), /\[Flyer text: OCTOBER 3-4\n10\/3 – RIVALS NY\]/);

  await withFlyerText(posts, { ocr, cache });
  assert.deepEqual(read, ["img-a"]);
});

test("a failed flyer read is retried next run", async () => {
  const cache = {};
  const posts = [{ id: "a", caption: "This weekend!", displayUrl: "img-a" }];
  const failed = await withFlyerText(posts, { ocr: async () => { throw new Error("expired"); }, cache });
  assert.equal(failed[0].flyerText, undefined);
  const retried = await withFlyerText(posts, { ocr: async () => "OCT 3", cache });
  assert.equal(retried[0].flyerText, "OCT 3");
});
