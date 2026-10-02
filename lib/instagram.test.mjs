import test from "node:test";
import assert from "node:assert/strict";
import {
  checkInstagramPoll,
  fetchInstagramProfiles,
  mergePosts,
  recordInstagramPoll,
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
    metaToken: undefined, apifyToken: "apify", now: NOW, log: quiet,
  });
  assert.equal(since, iso(2));
  // A profile with no new posts keeps its stored posts; one missing from results keeps its cache.
  assert.deepEqual(profiles.map((p) => [p.available, p.posts.length]), [[true, 1], [false, 0]]);
});

test("a not-found handle is marked checked so it stops forcing a 30-day lookback", async () => {
  const cache = {};
  await fetchInstagramProfiles([{ handle: "gone" }], cache, {
    runApify: async () => [{ inputUrl: "https://www.instagram.com/gone", error: "not_found" }],
    metaToken: undefined, apifyToken: "apify", now: NOW, log: quiet,
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
    fetchImpl: brokenMeta, metaToken: "meta", apifyToken: undefined, now: NOW, log: quiet,
  });
  assert.equal(profiles[0].available, false);
});

test("warns two weeks before Meta data access expires", async () => {
  const logs = [];
  await fetchInstagramProfiles([], {}, {
    fetchImpl: fakeGraph({}, { expiresInDays: 10 }), metaToken: "meta", apifyToken: undefined, now: NOW,
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
