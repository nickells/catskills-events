import test from "node:test";
import assert from "node:assert/strict";
import { deduplicateEvents } from "./dedup.mjs";

const ev = (name, venue, town, source, extra = {}) => ({ name, date: "2026-10-08", venue, town, source, ...extra });

test("one event listed by several sources is merged", () => {
  const merged = deduplicateEvents([
    ev("Margaret Glaspy", "Assembly", "Kingston", "Chronogram"),
    ev("Margaret Glaspy", "Assembly Kingston", "Kingston, NY", "Instagram @assemblykingston", { time: "8:00 PM" }),
    ev("Margaret Glaspy live", null, "Kingston", "HVNY"),
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sources.sort(), ["Chronogram", "HVNY", "Instagram @assemblykingston"]);
  assert.equal(merged[0].time, "8:00 PM");
});

test("same-named events at different places stay separate", () => {
  const merged = deduplicateEvents([
    ev("Trivia Night", "Awestruck Sidney Taproom", "Sidney", "Instagram @awestruckciders"),
    ev("Trivia Night", "Phoenicia Diner", "Mt. Tremper", "Instagram @someone"),
    ev("Trivia Night", "Keegan Ales", "Kingston", "Chronogram"),
  ]);
  assert.equal(merged.length, 3);
  assert.equal(merged.find((e) => e.venue === "Awestruck Sidney Taproom").town, "Sidney");
});

test("same town, different venues: only a specific name merges", () => {
  const specific = deduplicateEvents([
    ev("Hudson Oktoberfest presented by Upper Depot Brewing", "Upper Depot Brewing", "Hudson", "Instagram @lastingjoybrewery"),
    ev("Hudson Oktoberfest presented by Upper Depot Brewing", "Basilica Hudson", "Hudson", "Chronogram"),
  ]);
  assert.equal(specific.length, 1);
  const generic = deduplicateEvents([
    ev("Open Mic", "Tubby's", "Kingston", "Instagram @tubbyskingston"),
    ev("Open Mic", "Rough Draft Bar & Books", "Kingston", "Instagram @roughdraftny"),
  ]);
  assert.equal(generic.length, 2);
});
