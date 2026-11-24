import test from "node:test";
import assert from "node:assert/strict";
import { categorizeEvents, chooseCategory, KIDS_MIN_PROBABILITY } from "./categorize.mjs";

const answer = (choice) => ({ type: "choice", choice, confidence: 0.9, probabilities: { [choice]: 1 } });
const response = (answers) => ({ ok: true, status: 200, json: async () => ({ model: "jev-test", answers }) });
const options = { apiKey: "test-key", log: () => {}, now: 1000 };

test("missing key leaves categories and events intact without a request", async () => {
  const events = [{ name: "Jazz", category: "music" }];
  await categorizeEvents(events, {}, { ...options, apiKey: "", fetchImpl: () => assert.fail() });
  assert.deepEqual(events, [{ name: "Jazz", category: "music" }]);
});

test("fresh extractions default to other without a key or when Jev fails", async () => {
  for (const apiKey of ["", "test-key"]) {
    const events = [{ name: "Jazz" }, { name: "Unknown", category: "invalid" }];
    const stats = await categorizeEvents(events, {}, {
      ...options, apiKey, fetchImpl: async () => { throw new Error("unavailable"); },
    });
    assert.deepEqual(events.map(e => e.category), ["other", "other"]);
    assert.equal(stats.fallback, 2);
  }
});

test("batches independent choices, preserves fields, and reuses cached decisions", async () => {
  const events = [{ name: "Bit Brigade", date: "2026-10-01" }, { name: "Improv" }];
  const cache = {};
  const stats = await categorizeEvents(events, cache, { ...options, fetchImpl: async (url, init) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "jev-latest");
    assert.equal(body.state.events.length, 2);
    assert.match(body.questions.event_1.instructions, /events\[1\]/);
    assert.equal(body.state.events[0].category, undefined);
    return response({ event_0: answer("music"), event_1: answer("nightlife") });
  } });
  assert.equal(stats.classified, 2);
  assert.equal(events[0].date, "2026-10-01");
  assert.deepEqual(events.map(e => e.category), ["music", "nightlife"]);
  const cached = await categorizeEvents(events, cache, { ...options, fetchImpl: () => assert.fail() });
  assert.equal(cached.cached, 2);
  events[0].description = "Changed evidence";
  const changed = await categorizeEvents(events, cache, { ...options, fetchImpl: async () => response({ event_0: answer("other") }) });
  assert.equal(changed.classified, 1);
  assert.equal(events[0].category, "other");
});

test("offers kids as a category and accepts it as an answer", async () => {
  const events = [{ name: "Story Time with Natalie" }];
  await categorizeEvents(events, {}, { ...options, fetchImpl: async (url, init) => {
    assert.ok(Object.hasOwn(JSON.parse(init.body).questions.event_0.criteria, "kids"));
    return response({ event_0: answer("kids") });
  } });
  assert.equal(events[0].category, "kids");
});

test("kids is decided by its probability, not by a near-tie pick", () => {
  const pick = (choice, probabilities) => chooseCategory({ ...answer(choice), probabilities });
  // At or above the cutoff it is kids, even when another category edged it out.
  assert.equal(pick("other", { kids: KIDS_MIN_PROBABILITY, other: 0.5, culture: 0.2 }), "kids");
  // Below the cutoff a kids pick falls back to the most likely other category.
  assert.equal(pick("kids", { kids: 0.29, culture: 0.28, food: 0.2 }), "culture");
  // Below the cutoff any other pick stands.
  assert.equal(pick("music", { music: 0.8, kids: 0.2 }), "music");
  // Answers without probabilities keep their pick.
  assert.equal(chooseCategory({ type: "choice", choice: "kids", confidence: 0.9 }), "kids");
});

test("cached answers go through the same kids cutoff", async () => {
  const events = [{ name: "Sweet Retreat for Kids" }];
  const cache = {};
  const tie = { type: "choice", choice: "other", confidence: 0.5, probabilities: { other: 0.51, kids: 0.49 } };
  await categorizeEvents(events, cache, { ...options, fetchImpl: async () => response({ event_0: tie }) });
  assert.equal(events[0].category, "kids");
  delete events[0].category;
  await categorizeEvents(events, cache, { ...options, fetchImpl: () => assert.fail() });
  assert.equal(events[0].category, "kids");
});

test("invalid and missing answers preserve fallbacks and are not cached", async () => {
  const events = [{ name: "A", category: "food" }, { name: "B", category: "nature" }];
  const cache = {};
  const stats = await categorizeEvents(events, cache, { ...options, fetchImpl: async () => response({ event_0: answer("unknown") }) });
  assert.equal(stats.fallback, 2);
  assert.deepEqual(events.map(e => e.category), ["food", "nature"]);
  assert.deepEqual(cache, {});
});

test("retries throttling with backoff before applying the answer", async () => {
  let requests = 0;
  const delays = [];
  const events = [{ name: "Jazz", category: "other" }];
  await categorizeEvents(events, {}, { ...options, wait: async ms => delays.push(ms), fetchImpl: async () => {
    requests++;
    return requests < 3 ? { ok: false, status: 429 } : response({ event_0: answer("music") });
  } });
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(events[0].category, "music");
});

test("outage stops subsequent batches and preserves every event", async () => {
  const events = Array.from({ length: 21 }, (_, i) => ({ name: `Event ${i}`, category: "community" }));
  let calls = 0;
  const stats = await categorizeEvents(events, {}, { ...options, fetchImpl: async () => { calls++; throw new Error("timeout"); } });
  assert.equal(calls, 1);
  assert.equal(stats.fallback, 21);
  assert.ok(events.every(e => e.category === "community"));
});
