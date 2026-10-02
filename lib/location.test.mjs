import test from "node:test";
import assert from "node:assert/strict";
import { filterOutsideNewYork, isOutsideNewYork } from "./location.mjs";

test("flags venues and addresses clearly outside New York", () => {
  for (const venue of [
    "55 Ingersoll Rd, Woodstock, ON N4S 2R1, Canada",
    "595487 Oxford 59 N, Woodstock, ON, Canada, Ontario N4S7W1",
    "22 Reeve Street, Woodstock, ON, Canada",
    "Woodstock, Ontario",
    "Town Green, Woodstock, VT 05091",
    "Main St, Milford, PA",
    "Some Hall, N4S 2R1",
  ]) {
    assert.equal(isOutsideNewYork({ venue }), true, venue);
  }
  assert.equal(isOutsideNewYork({ venue: "Fairgrounds", address: "1 Main St, Hartford, CT 06103" }), true);
});

test("keeps New York and ambiguous venues", () => {
  for (const venue of [
    "Main St, Windham, NY 12496, United States",
    "Bearsville Theater",
    "Upper Thames Brewing Company",
    "Levon Helm Studios (Woodstock)",
    "On the Green, Phoenicia",
    "ONE Arts Center",
    undefined,
  ]) {
    assert.equal(isOutsideNewYork({ venue }), false, String(venue));
  }
});

test("filterOutsideNewYork splits kept and dropped events", () => {
  const ny = { name: "Jazz Night", venue: "Colony, Woodstock, NY 12498" };
  const on = { name: "2026 Intro to Mosaics Series", venue: "55 Ingersoll Rd, Woodstock, ON N4S 2R1, Canada", town: "Woodstock" };
  const { kept, dropped } = filterOutsideNewYork([ny, on]);
  assert.deepEqual(kept, [ny]);
  assert.deepEqual(dropped, [on]);
});
