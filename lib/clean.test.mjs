import test from "node:test";
import assert from "node:assert/strict";
import { cleanEvent, townCase, dropClosures } from "./clean.mjs";

test("null-like text becomes a real null", () => {
  const e = cleanEvent({ name: "Artist Talk: Landlooker", venue: "null", town: "NULL", time: " ", url: "None", description: "n/a" });
  assert.deepEqual(e, { name: "Artist Talk: Landlooker", venue: null, town: null, time: null, url: null, description: null });
});

test("real values, including ones containing the word null, are kept", () => {
  const e = { name: "Null Island Dance Party", venue: "Annulled Records", town: "Narrowsburg", _lat: 41.6, sources: ["x"] };
  assert.deepEqual(cleanEvent({ ...e }), e);
});

test("all-caps and all-lowercase towns are title-cased; mixed case is kept", () => {
  assert.equal(townCase("SAUGERTIES"), "Saugerties");
  assert.equal(townCase("livingston manor"), "Livingston Manor");
  assert.equal(townCase("TOWN OF SHANDAKEN"), "Town of Shandaken");
  assert.equal(townCase("Mt Tremper"), "Mt Tremper");
  assert.equal(townCase("McKinley"), "McKinley");
  assert.equal(townCase(null), null);
});

test("a listing's town tail comes off the title", () => {
  assert.equal(cleanEvent({ name: "Next Stop Comedy at Big Eddy Brewing Co.! - Narrowsburg, NY" }).name, "Next Stop Comedy at Big Eddy Brewing Co.!");
  assert.equal(cleanEvent({ name: "A Face in the Crowd - 11/14/26 @ 2:00 pm" }).name, "A Face in the Crowd - 11/14/26 @ 2:00 pm");
});

test("a closing notice is dropped along with what's listed at that venue that day", () => {
  const at = (name, date, venue = "Wayside Cider") => ({ name, date, venue, town: "Andes" });
  const kept = dropClosures([
    at("Closed for the Holiday", "2026-11-26"),
    at("Locals Night at Wayside Cider", "2026-11-26"),
    at("Locals Night at Wayside Cider", "2026-11-19"),
    at("Trivia", "2026-11-26", "Andes Hotel"),
    at("Hotel & Restaurant CLOSED for Holiday", "2026-11-29", "Shandaken Inn"),
    at("CLOSED", "2026-12-20", "Tubby's"),
    at("Saugerties 5K: Closed Course and Fans to Cheer!!", "2027-07-04", "Greco Center"),
  ]).map((e) => `${e.date} ${e.name}`);
  assert.deepEqual(kept, [
    "2026-11-19 Locals Night at Wayside Cider",
    "2026-11-26 Trivia",
    "2027-07-04 Saugerties 5K: Closed Course and Fans to Cheer!!",
  ]);
});
