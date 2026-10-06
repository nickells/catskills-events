import test from "node:test";
import assert from "node:assert/strict";
import { detectCalendar, discoverCalendars, eventPageLinks, readCalendar, squarespaceEvents, tribeEvents } from "./calendars.mjs";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const quiet = () => {};
// Oct 9 2026, 8pm in New York
const OCT9_8PM = Date.parse("2026-10-10T00:00:00Z");

const squarespace = {
  collection: { typeName: "events" },
  upcoming: [
    { title: "Woodsist Warmup &amp; Friends", startDate: OCT9_8PM, fullUrl: "/calendar/woodsist", excerpt: "<p>Doors 7</p>", location: { addressTitle: "", addressLine2: "" } },
    { title: "Plant Walk", startDate: OCT9_8PM, fullUrl: "/calendar/walk", location: { addressTitle: "Visitor Center", addressLine2: "Mt Tremper, NY, 12457" } },
  ],
};
const tribe = {
  events: [
    { title: "Movement in the Meadow", start_date: "2026-10-11 11:00:00", all_day: false, url: "https://inn.example/event/m/", venue: { venue: "Shandaken Inn", city: "Shandaken", state: "NY" }, description: "<h2>Save the date</h2>" },
    { title: "Harvest Day", start_date: "2026-10-12 00:00:00", all_day: true, url: "https://inn.example/event/h/", venue: [] },
    { title: "Elsewhere", start_date: "2026-10-12 10:00:00", venue: { venue: "Far Hall", state: "VT" } },
  ],
};

test("Squarespace events read in New York time, with HTML stripped and links absolute", () => {
  assert.deepEqual(squarespaceEvents(squarespace, "https://tubbys.example/calendar"), [
    { name: "Woodsist Warmup & Friends", date: "2026-10-09", time: "8:00 PM", venue: null, town: null, description: "Doors 7", url: "https://tubbys.example/calendar/woodsist" },
    { name: "Plant Walk", date: "2026-10-09", time: "8:00 PM", venue: "Visitor Center", town: "Mt Tremper", description: null, url: "https://tubbys.example/calendar/walk" },
  ]);
  assert.deepEqual(squarespaceEvents({ collection: { typeName: "products" }, items: [{ title: "Mug" }] }), []);
  assert.deepEqual(squarespaceEvents(null), []);
});

test("WordPress events keep New York venues and read all-day events without a time", () => {
  const events = tribeEvents(tribe);
  assert.deepEqual(events.map((e) => [e.name, e.date, e.time, e.venue, e.town]), [
    ["Movement in the Meadow", "2026-10-11", "11:00 AM", "Shandaken Inn", "Shandaken"],
    ["Harvest Day", "2026-10-12", null, null, null],
  ]);
  assert.equal(events[0].description, "Save the date");
});

test("a calendar's venue and town fill what its listings leave out", async () => {
  const events = await readCalendar(
    { url: "https://tubbys.example/calendar", calendar: "squarespace", venue: "Tubby's", town: "Kingston" },
    { fetchPage: async (url) => (assert.equal(url, "https://tubbys.example/calendar?format=json"), JSON.stringify(squarespace)) },
  );
  assert.deepEqual(events.map((e) => [e.venue, e.town]), [["Tubby's", "Kingston"], ["Visitor Center", "Mt Tremper"]]);
});

test("event links are same-site listing pages, most general first", () => {
  const html = `<a href="/events/jazz-night">x</a><a href="/events/">x</a><a href="https://other.example/events">x</a>
    <a href="/about">x</a><a href="/calendar?view=list">x</a>`;
  assert.deepEqual(eventPageLinks(html, "https://venue.example/"), [
    "https://venue.example/events", "https://venue.example/calendar", "https://venue.example/events/jazz-night",
  ]);
});

const site = (pages) => async (url) => pages[url] ?? null;

test("detection picks the richest readable calendar and ignores a lone event", async () => {
  const fetchPage = site({
    "https://venue.example/": `<script src="https://static1.squarespace.com/x.js"></script><a href="/calendar">Calendar</a>`,
    "https://venue.example/calendar?format=json": JSON.stringify(squarespace),
    "https://venue.example/calendar": "<p>calendar</p>",
  });
  assert.deepEqual(await detectCalendar("https://venue.example/", { fetchPage, today: "2026-10-06" }),
    { url: "https://venue.example/calendar", calendar: "squarespace", count: 2 });

  const lone = site({
    "https://one.example/": `<a href="/events/fest">Fest</a>`,
    "https://one.example/events/fest": `<script type="application/ld+json">{"@type":"Event","name":"Fest","startDate":"2026-10-10"}</script>`,
  });
  assert.equal(await detectCalendar("https://one.example/", { fetchPage: lone, today: "2026-10-06" }), null);
});

test("WordPress sites are checked for The Events Calendar's API", async () => {
  const fetchPage = site({
    "https://inn.example/": `<link href="/wp-content/themes/x.css">`,
    "https://inn.example/wp-json/tribe/events/v1/events?per_page=50": JSON.stringify(tribe),
  });
  assert.deepEqual(await detectCalendar("https://inn.example/", { fetchPage, today: "2026-10-06" }),
    { url: "https://inn.example/", calendar: "tribe", count: 2 });
});

test("discovery registers found calendars, skips known hosts and remembers misses", async () => {
  const pages = {
    "https://inn.example/": `<link href="/wp-content/x.css">`,
    "https://inn.example/wp-json/tribe/events/v1/events?per_page=50": JSON.stringify(tribe),
    "https://plain.example/": "<p>hi</p>",
  };
  const fetched = [];
  const fetchPage = async (url) => (fetched.push(url), pages[url] ?? null);
  const registry = { accepted: [] };
  const cache = {};
  const sites = [
    { site: "https://inn.example/", venue: "Shandaken Inn", town: "Shandaken", via: "@shandakeninn" },
    { site: "https://plain.example/", via: "event link" },
    { site: "https://listing.example/", via: "event link" },
  ];
  const added = await discoverCalendars({ sites, registry, cache, fetchPage, skipHosts: ["listing.example"], now: NOW, log: quiet });
  assert.deepEqual(added, [{
    name: "Shandaken Inn", url: "https://inn.example/", calendar: "tribe", venue: "Shandaken Inn", town: "Shandaken",
    addedAt: "2026-10-06", foundVia: "@shandakeninn",
  }]);
  assert.deepEqual(registry.calendars, added);
  assert.equal(fetched.some((url) => url.includes("listing.example")), false);

  fetched.length = 0;
  await discoverCalendars({ sites, registry, cache, fetchPage, skipHosts: ["listing.example"], now: NOW + 1000, log: quiet });
  assert.deepEqual(fetched, [], "known calendars and recent misses aren't refetched");
});
