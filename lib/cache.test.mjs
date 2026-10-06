import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCache } from "./cache.mjs";

test("changes to events after caching or reading them don't reach the cache", () => {
  const file = join(mkdtempSync(join(tmpdir(), "cache-")), "scrape-cache.json");
  const cache = openCache(file);
  const events = [{ name: "Hike to Mud Lake", town: null }];
  cache.set("k", events);
  events[0].town = "Davenport"; // as geocoding fills it from the landmark
  cache.get("k")[0].town = "Davenport";
  cache.save();
  assert.deepEqual(openCache(file).get("k"), [{ name: "Hike to Mud Lake", town: null }]);
});

test("entries older than the TTL are misses", () => {
  const cache = openCache(join(mkdtempSync(join(tmpdir(), "cache-")), "c.json"));
  cache.data.old = { ts: Date.now() - 2000, events: [1] };
  assert.equal(cache.get("old", 1000), null);
  assert.deepEqual(cache.get("old", 5000), [1]);
});
