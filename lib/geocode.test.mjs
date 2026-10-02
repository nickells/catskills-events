import test from "node:test";
import assert from "node:assert/strict";
import { isInNewYork, parseNominatimResult } from "./geocode.mjs";

const hit = (lat, lon, iso, address = {}) => [{ lat: String(lat), lon: String(lon), address: { "ISO3166-2-lvl4": iso, ...address } }];

test("only Nominatim results in New York are accepted", () => {
  assert.deepEqual(
    parseNominatimResult(hit(41.695, -74.522, "US-NY", { hamlet: "Mountain Dale" })),
    { coords: [41.695, -74.522], town: "Mountain Dale" },
  );
  assert.equal(parseNominatimResult(hit(41.388, -83.663, "US-OH", { town: "Bowling Green" })), null);
  assert.equal(parseNominatimResult([{ lat: "53.425", lon: "-6.478", address: { country_code: "ie" } }]), null);
  assert.equal(parseNominatimResult([]), null);
});

test("the town prefix is stripped from the resolved town", () => {
  assert.equal(parseNominatimResult(hit(42.827, -75.544, "US-NY", { village: "Village of Hamilton" })).town, "Hamilton");
});

test("cached coordinates outside New York are not trusted", () => {
  assert.equal(isInNewYork([41.695, -74.522]), true); // Mountain Dale
  assert.equal(isInNewYork([53.425, -6.478]), false); // Ireland
  assert.equal(isInNewYork([41.388, -83.663]), false); // Ohio
});
