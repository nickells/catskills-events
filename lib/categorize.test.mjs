import test from "node:test";
import assert from "node:assert/strict";
import { categorizeEvents } from "./categorize.mjs";

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
