import test from "node:test";
import assert from "node:assert/strict";
import { isInRegion, landmarkQueries, parseNominatimResult } from "./geocode.mjs";

const hit = (lat, lon, addresstype, address = {}) => [{ lat: String(lat), lon: String(lon), addresstype, address }];

test("only Nominatim results in the region are accepted", () => {
  assert.deepEqual(
    parseNominatimResult(hit(41.695, -74.522, "hamlet", { hamlet: "Mountain Dale" })),
    { coords: [41.695, -74.522], town: "Mountain Dale" },
  );
  assert.ok(parseNominatimResult(hit(42.110, -73.353, "village", { village: "Sheffield" }))); // Sheffield, MA
  assert.equal(parseNominatimResult(hit(41.388, -83.663, "road")), null); // Bowling Green, Ohio
  assert.equal(parseNominatimResult(hit(53.425, -6.478, "suburb")), null); // near Dublin
  assert.equal(parseNominatimResult(hit(42.985, -78.747, "park")), null); // near Buffalo
  assert.equal(parseNominatimResult([]), null);
});

test("a town lookup must return a settlement, not a same-named street", () => {
  const alba = hit(41.215, -73.201, "road", { road: "Alba Avenue" }); // Bridgeport, CT
  assert.ok(parseNominatimResult(alba));
  assert.equal(parseNominatimResult(alba, { placeOnly: true }), null);
  assert.equal(parseNominatimResult(hit(42.827, -75.544, "village", { village: "Village of Hamilton" }), { placeOnly: true }).town, "Hamilton");
});

test("cached coordinates outside the region are not trusted", () => {
  assert.equal(isInRegion([41.695, -74.522]), true); // Mountain Dale
  assert.equal(isInRegion([42.110, -73.353]), true); // Sheffield, MA
  assert.equal(isInRegion([53.425, -6.478]), false); // Ireland
  assert.equal(isInRegion([41.388, -83.663]), false); // Ohio
});

test("landmark lookups try the names OSM uses", () => {
  assert.deepEqual(landmarkQueries("Mount Utsayantha Fire Tower"), ["Mount Utsayantha Fire Tower", "Mount Utsayantha", "Utsayantha"]);
  assert.deepEqual(landmarkQueries("Pakatakan Mountain"), ["Pakatakan Mountain"]);
});

test("a landmark result must be called that and lie in the Catskills core", () => {
  const core = { south: 41.45, north: 42.6, west: -75.3, east: -73.55 };
  const named = (name, lat, lon) => [{ name, lat: String(lat), lon: String(lon), addresstype: "peak", address: {} }];
  assert.ok(parseNominatimResult(named("John Burroughs Woodchuck Lodge", 42.296, -74.584), { bounds: core, name: "Woodchuck Lodge" }));
  assert.ok(parseNominatimResult(named("Utsayantha Mountain", 42.399, -74.590), { bounds: core, name: "Utsayantha" }));
  assert.equal(parseNominatimResult(named("Hewlett Lodge", 42.296, -74.584), { bounds: core, name: "Woodchuck Lodge" }), null);
  assert.equal(parseNominatimResult(named("Mud Lake", 43.181, -76.409), { bounds: core, name: "Mud Lake" }), null); // near Syracuse
});
