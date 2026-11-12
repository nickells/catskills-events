import { test } from "node:test";
import assert from "node:assert/strict";
import { enrichEvents } from "./enrich.mjs";

test("enrichEvents passes each stage's output to the next, with the run context", async () => {
  const ctx = { cache: {} };
  const seen = [];
  const stages = [
    (events, c) => { seen.push(c); return events.filter((e) => e.keep); },
    async (events) => events.map((e) => ({ ...e, town: "Phoenicia" })),
  ];
  const out = await enrichEvents([{ name: "A", keep: true }, { name: "B" }], ctx, stages);
  assert.deepEqual(out, [{ name: "A", keep: true, town: "Phoenicia" }]);
  assert.equal(seen[0], ctx);
});

test("places are settled before dedupe, and past events dropped before any lookup", async () => {
  const { STAGES } = await import("./enrich.mjs");
  const order = STAGES.map((stage) => stage.name);
  assert.ok(order.indexOf("normalizeTowns") < order.indexOf("locate"));
  assert.ok(order.indexOf("locate") < order.indexOf("dedupe"));
  assert.ok(order.indexOf("dedupe") < order.indexOf("geocode"));
  assert.equal(order.indexOf("dropPast"), 1);
});

test("an undated event ages out with its post; dated ones go by their date", async () => {
  const { dropPast } = await import("./enrich.mjs");
  const now = Date.parse("2026-11-12T18:00:00Z");
  const days = (n) => new Date(now - n * 86400000).toISOString();
  const kept = dropPast([
    { name: "Halloween Party", date: null, _postedAt: days(13) },
    { name: "Trivia This Friday", date: null, _postedAt: days(3) },
    { name: "Undated, no post", date: null, url: "https://example.com/show" },
    { name: "Upcoming show", date: "2026-11-20", _postedAt: days(25) },
    { name: "Last week", date: "2026-11-01" },
  ], {}, now).map((e) => e.name);
  assert.deepEqual(kept, ["Trivia This Friday", "Undated, no post", "Upcoming show"]);
});
