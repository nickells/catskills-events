import test from "node:test";
import assert from "node:assert/strict";
import { discoverInstagramSources, rankCandidates, scanForMentions } from "./discover.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-02T12:00:00Z");
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const quiet = () => {};
const sources = [{ handle: "venue_a", town: "Phoenicia" }, { handle: "venue_b", town: "Woodstock" }];
const cacheWith = (posts) => Object.fromEntries(Object.entries(posts).map(([handle, list]) => [
  `instagram-posts:${handle}`, { ts: NOW, events: { posts: list.map(([caption, daysAgo = 1]) => ({ caption, timestamp: iso(daysAgo) })) } },
]));
// Stands in for gpt-4o-mini: treats each "mention:" word in a caption as a username.
const fakeExtract = async (captions) => captions.map((caption) => [...caption.matchAll(/mention:(\S+)/g)].map((m) => m[1]));
const profile = (username) => ({
  username, name: username, biography: "Shows and markets", mediaCount: 10,
  posts: [{ caption: "Live music Friday at our barn in Phoenicia", timestamp: iso(2) }],
});
const jevSays = (kind, confidence = 0.9, town = "phoenicia") => async (state, questions) => ({
  answers: {
    kind: { type: "choice", choice: kind, confidence },
    ...(questions.town && { town: { type: "choice", choice: town, confidence: 0.8 } }),
  },
});
const run = (cache, registry, overrides = {}) => discoverInstagramSources({
  sources, cache, registry, now: NOW, log: quiet, extractMentions: fakeExtract, ...overrides,
});

test("mentions are tallied by source, ignoring known sources, and ranked by reach", async () => {
  const cache = cacheWith({
    venue_a: [["mention:The_Band mention:farm_stand"], ["thanks mention:venue_b mention:farm_stand"]],
    venue_b: [["market mention:farm_stand"]],
  });
  const tally = await scanForMentions(sources, cache, { extractMentions: fakeExtract, now: NOW, log: quiet });
  assert.deepEqual(rankCandidates(tally).map((c) => [c.handle, c.sources.length, c.mentions]), [
    ["farm_stand", 2, 3], ["the_band", 1, 1],
  ]);
});

test("each caption is only sent for extraction once", async () => {
  const cache = cacheWith({ venue_a: [["mention:x", 2]] });
  let sent = 0;
  const counting = async (captions) => { sent += captions.length; return fakeExtract(captions); };
  await scanForMentions(sources, cache, { extractMentions: counting, now: NOW, log: quiet });
  cache["instagram-posts:venue_a"].events.posts.push({ caption: "new mention:y", timestamp: iso(0) });
  const tally = await scanForMentions(sources, cache, { extractMentions: counting, now: NOW, log: quiet });
  assert.equal(sent, 2);
  assert.deepEqual(Object.keys(tally).sort(), ["x", "y"]);
});

test("a failed extraction leaves those captions to be scanned next run", async () => {
  const cache = cacheWith({ venue_a: [["mention:x"]] });
  await scanForMentions(sources, cache, { extractMentions: async () => { throw new Error("HTTP 500"); }, now: NOW, log: quiet });
  const tally = await scanForMentions(sources, cache, { extractMentions: fakeExtract, now: NOW, log: quiet });
  assert.deepEqual(Object.keys(tally), ["x"]);
});

test("event hosts are added with a town; others are rejected with a reason", async () => {
  const registry = { accepted: [] };
  const cache = cacheWith({ venue_a: [["mention:barn_shows mention:solo_singer mention:not_real"]] });
  const lookups = { barn_shows: profile("barn_shows"), solo_singer: profile("solo_singer"), not_real: null };
  const verdicts = { barn_shows: jevSays("event_host"), solo_singer: jevSays("performer") };
  const stats = await run(cache, registry, {
    lookupProfile: async (handle) => lookups[handle],
    askJevImpl: (state, questions) => verdicts[state.account.username](state, questions),
  });
  assert.deepEqual(registry.accepted, [
    { handle: "barn_shows", town: "Phoenicia", addedAt: "2026-10-02", foundVia: ["venue_a"] },
  ]);
  assert.deepEqual(cache["discovery-rejected"].events, {
    solo_singer: { reason: "performer", at: "2026-10-02" },
    not_real: { reason: "not_business", at: "2026-10-02" },
  });
  assert.equal(stats.vetted, 3);
});

test("low confidence is rejected, and rejections are rechecked after 90 days", async () => {
  const cache = cacheWith({ venue_a: [["mention:maybe_venue"]] });
  const registry = { accepted: [] };
  const options = (now) => ({ now, lookupProfile: async (handle) => profile(handle), askJevImpl: jevSays("event_host", 0.5) });
  await run(cache, registry, options(NOW));
  assert.equal(cache["discovery-rejected"].events.maybe_venue.reason, "low_confidence");
  assert.equal((await run(cache, registry, options(NOW + 30 * DAY))).vetted, 0);
  // Re-mentioned later, so it is still tracked when the 90 days are up.
  cache["instagram-posts:venue_a"].events.posts.push({ caption: "again mention:maybe_venue", timestamp: new Date(NOW + 80 * DAY).toISOString() });
  assert.equal((await run(cache, registry, options(NOW + 91 * DAY))).vetted, 1);
});

test("a Jev or Meta failure stops discovery without recording a decision", async () => {
  const cache = cacheWith({ venue_a: [["mention:one mention:two"]] });
  const registry = { accepted: [] };
  await run(cache, registry, { lookupProfile: async (h) => profile(h), askJevImpl: async () => { throw new Error("HTTP 503"); } });
  await run(cache, registry, { lookupProfile: async () => { throw new Error("rate limited"); }, askJevImpl: jevSays("event_host") });
  assert.deepEqual(registry.accepted, []);
  assert.deepEqual(cache["discovery-rejected"].events, {});
});

test("inactive accounts are rejected without asking Jev", async () => {
  const cache = cacheWith({ venue_a: [["mention:old_place"]] });
  let asked = false;
  await run(cache, { accepted: [] }, {
    lookupProfile: async () => ({ ...profile("old_place"), posts: [{ caption: "", timestamp: "2024-01-01T00:00:00Z" }] }),
    askJevImpl: async () => { asked = true; },
  });
  assert.equal(cache["discovery-rejected"].events.old_place.reason, "inactive");
  assert.equal(asked, false);
});
