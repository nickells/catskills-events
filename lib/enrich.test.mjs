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
