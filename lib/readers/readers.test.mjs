import { test } from "node:test";
import assert from "node:assert/strict";
import { readSources } from "./index.mjs";
import { cachedEvents } from "./cached.mjs";
import { tockifyEvents } from "./tockify.mjs";
import { townFromUrl, backfillTown } from "./page.mjs";

const memoryCache = () => {
  const data = {};
  return {
    data,
    get: (key) => data[key]?.events ?? null,
    set: (key, events) => { data[key] = { ts: Date.now(), events }; },
    save() {},
  };
};

test("readSources dispatches by type and keeps going past a failing source", async () => {
  const readers = {
    ok: async (source) => [{ name: source.name }],
    broken: async () => { throw new Error("down"); },
  };
  const sources = [{ type: "ok", name: "A" }, { type: "broken", name: "B" }, { type: "missing", name: "C" }, { type: "ok", name: "D" }];
  const events = await readSources(sources, { cache: memoryCache() }, readers);
  assert.deepEqual(events.map((e) => e.name), ["A", "D"]);
});

test("cachedEvents tags fresh events with their source and serves them from the cache after", async () => {
  const cache = memoryCache();
  let reads = 0;
  const opts = { name: "Venue", sourceUrl: "https://venue.example/", read: async () => (reads++, [{ name: "Show" }]) };
  const fresh = await cachedEvents(cache, "k", opts);
  const again = await cachedEvents(cache, "k", opts);
  assert.deepEqual(fresh, [{ name: "Show", source: "Venue", sourceUrl: "https://venue.example/" }]);
  assert.deepEqual(again, fresh);
  assert.equal(reads, 1);
});

test("tockifyEvents maps API events and skips undated and online-only ones", () => {
  const start = Date.parse("2026-10-10T23:00:00Z");
  const events = tockifyEvents({
    events: [
      { eid: { uid: "u1", tid: start }, when: { start: { millis: start } },
        content: { summary: { text: "Locals Night at Wayside Cider" }, tagset: { tags: { default: ["Cider", "andes"] } } } },
      { eid: { uid: "u2" }, when: { start: { millis: start } }, content: { summary: { text: "Online Workshop" } } },
      { eid: { uid: "u3" }, when: {}, content: { summary: { text: "No date" } } },
    ],
  }, "gwc");
  assert.equal(events.length, 1);
  assert.deepEqual(
    { ...events[0], description: undefined },
    {
      name: "Locals Night at Wayside Cider", date: "2026-10-10", time: "7:00 PM", venue: "Wayside Cider",
      town: "andes", description: undefined, url: `https://tockify.com/gwc/detail/u1/${start}`, category: "food",
      _lat: null, _lng: null,
    },
  );
});

test("page readers take the town from an AllEvents URL or a known town in the venue", () => {
  assert.equal(townFromUrl("https://allevents.in/saugerties-ny/all"), "Saugerties");
  assert.equal(townFromUrl("https://allevents.in/new-paltz-new-york/all"), "New Paltz");
  assert.equal(townFromUrl("https://example.com/events"), null);
  assert.deepEqual(backfillTown({ venue: "Town Hall (Woodstock)" }, "Kingston"), { venue: "Town Hall", town: "Woodstock" });
  assert.deepEqual(backfillTown({ venue: "Bar (Upstairs)" }, "Kingston"), { venue: "Bar (Upstairs)", town: "Kingston" });
});
