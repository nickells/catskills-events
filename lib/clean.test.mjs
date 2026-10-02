import test from "node:test";
import assert from "node:assert/strict";
import { cleanEvent } from "./clean.mjs";

test("null-like text becomes a real null", () => {
  const e = cleanEvent({ name: "Artist Talk: Landlooker", venue: "null", town: "NULL", time: " ", url: "None", description: "n/a" });
  assert.deepEqual(e, { name: "Artist Talk: Landlooker", venue: null, town: null, time: null, url: null, description: null });
});

test("real values, including ones containing the word null, are kept", () => {
  const e = { name: "Null Island Dance Party", venue: "Annulled Records", town: "Narrowsburg", _lat: 41.6, sources: ["x"] };
  assert.deepEqual(cleanEvent({ ...e }), e);
});
