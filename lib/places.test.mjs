import test from "node:test";
import assert from "node:assert/strict";
import { stripState, townKey, squashPlace } from "./places.mjs";

test("a state suffix is stripped only after a comma or space", () => {
  assert.equal(stripState("Catskill, NY"), "Catskill");
  assert.equal(stripState("Hudson New York"), "Hudson");
  assert.equal(stripState("Callicoon, N.Y."), "Callicoon");
  assert.equal(stripState("Albany"), "Albany");
  assert.equal(townKey("Albany, NY"), "albany");
});

test("places compare without case, punctuation, state or a leading the", () => {
  assert.equal(squashPlace("The Avalon Lounge"), squashPlace("Avalon Lounge, NY"));
});
