import test from "node:test";
import assert from "node:assert/strict";
import { locateEvents } from "./locate.mjs";

const townCoords = { woodstock: [42.04, -74.12], rhinebeck: [41.93, -73.91] };
const NOW = Date.parse("2026-10-02T12:00:00Z");
const quiet = () => {};

test("events with a known town are left alone", async () => {
  const e = { name: "Show", town: "Woodstock, NY", url: "https://example.com/show" };
  const r = await locateEvents([e], {
    townCoords, now: NOW,
    fetchText: () => assert.fail("no page fetch"), askPage: () => assert.fail(), askKnowledge: () => assert.fail(),
  });
  assert.deepEqual(r, { checked: 0, located: 0 });
  assert.equal(e._state, undefined);
});

test("the event's page is read first and fills a missing venue", async () => {
  const e = { name: "Heidi Schreck’s What the Constitution Means to Me", town: null, venue: null, url: "https://www.catskillmtn.org/event/x/" };
  const asked = [];
  await locateEvents([e], {
    townCoords, now: NOW,
    fetchText: async () => "Thursday, October 22 @ 7:00 pm Loomie’s Luncheonette 466 Main Street Catskill, NY 12414",
    askPage: async (ev, text) => { asked.push(text); return { venue: "Loomie’s Luncheonette", town: "Catskill", state: "NY" }; },
    askKnowledge: () => assert.fail("page answered"),
  });
  assert.equal(asked.length, 1);
  assert.deepEqual([e.town, e._state, e.venue], ["Catskill", "NY", "Loomie’s Luncheonette"]);
});

test("without a readable page the model's knowledge corrects the town", async () => {
  const alba = { name: "Opening", town: "Alba", venue: "Opalka Gallery" };
  const sheffield = { name: "Chairs", town: "Sheffield", venue: "Andrew Jack Chairs", url: "https://www.instagram.com/p/abc/" };
  await locateEvents([alba, sheffield], {
    townCoords, now: NOW,
    fetchText: () => assert.fail("Instagram pages aren't fetched"), askPage: () => assert.fail(),
    askKnowledge: async (events) => events.map((e) => (e === alba ? { town: "Albany", state: "NY" } : { town: "Sheffield", state: "MA" })),
  });
  assert.deepEqual([alba.town, alba._state], ["Albany", "NY"]);
  assert.deepEqual([sheffield.town, sheffield._state], ["Sheffield", "MA"]);
});

test("an event nobody can place keeps its town, and the answer is cached", async () => {
  const e = { name: "Mystery", town: "Nowhere", venue: "Somewhere" };
  const cache = {};
  let calls = 0;
  const deps = {
    townCoords, cache, now: NOW, log: quiet, fetchText: async () => null, askPage: async () => null,
    askKnowledge: async (events) => { calls++; return events.map(() => ({ town: null })); },
  };
  assert.deepEqual(await locateEvents([e], deps), { checked: 1, located: 0 });
  assert.equal(e.town, "Nowhere");
  await locateEvents([{ ...e }], deps);
  assert.equal(calls, 1);
});

test("a failed lookup is not cached, so the next run retries", async () => {
  const cache = {};
  await locateEvents([{ name: "X", town: "Nowhere" }], {
    townCoords, cache, now: NOW, log: quiet, fetchText: async () => null, askPage: async () => null,
    askKnowledge: async () => { throw new Error("rate limited"); },
  });
  assert.deepEqual(cache, {});
});

test("a page address without a state is resolved by the model, keeping the page's venue", async () => {
  const e = { name: "Fan Back Chairmaking Workshop", town: "Sheffield", venue: "Andrew Jack Fan Back", url: "https://calendar.example.com/x" };
  let sentToModel;
  await locateEvents([e], {
    townCoords, now: NOW, log: quiet,
    fetchText: async () => "Venue Details Andrew Jack Chairs 292 S Main Street, Sheffield",
    askPage: async () => ({ venue: "Andrew Jack Chairs", town: "Sheffield", state: null }),
    askKnowledge: async (events) => { sentToModel = events[0]; return [{ town: "Sheffield", state: "MA" }]; },
  });
  assert.equal(sentToModel.venue, "Andrew Jack Chairs");
  assert.deepEqual([e.town, e._state], ["Sheffield", "MA"]);
});
