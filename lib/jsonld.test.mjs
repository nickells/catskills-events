import test from "node:test";
import assert from "node:assert/strict";
import { extractJsonLdEvents } from "./jsonld.mjs";

const page = (...blocks) => `<html><head>${blocks.map((b) => `<script type="application/ld+json">${typeof b === "string" ? b : JSON.stringify(b)}</script>`).join("")}</head></html>`;
const place = (name, town, region = "NY") => ({
  "@type": "Place", name,
  address: { "@type": "PostalAddress", streetAddress: "1 Main St", addressLocality: town, addressRegion: region, addressCountry: "US" },
});

test("reads an Eventbrite-style ItemList of events", () => {
  const events = extractJsonLdEvents(page({
    "@type": "ItemList",
    itemListElement: [{ "@type": "ListItem", position: 1, item: {
      "@type": "Event", name: "Spellbound in the Valley", startDate: "2026-10-23", endDate: "2026-10-23",
      url: "https://www.eventbrite.com/e/spellbound-1934431961069", description: "Bookish fun.",
      location: place("MJN Convention Center", "Poughkeepsie"),
    } }],
  }));
  assert.deepEqual(events, [{
    name: "Spellbound in the Valley", date: "2026-10-23", time: null, venue: "MJN Convention Center",
    town: "Poughkeepsie", description: "Bookish fun.", url: "https://www.eventbrite.com/e/spellbound-1934431961069",
  }]);
});

test("reads AllEvents-style top-level events and subtypes, across several blocks", () => {
  const events = extractJsonLdEvents(page(
    { "@context": "https://schema.org", "@type": "Event", name: "Field + Supply Fall MRKT", startDate: "2026-10-09",
      url: "https://allevents.in/kingston/field-supply/1", location: place("Hutton Brickyards", "Kingston"), description: "" },
    [{ "@type": "MusicEvent", name: "Margaret Glaspy", startDate: "2026-10-03T20:00:00-04:00", location: place("Assembly", "Kingston") }],
  ));
  assert.equal(events.length, 2);
  assert.equal(events[0].description, null);
  assert.deepEqual([events[1].name, events[1].date, events[1].time], ["Margaret Glaspy", "2026-10-03", "8:00 PM"]);
});

test("a start time is given in the Catskills' time zone, including the date", () => {
  const [e] = extractJsonLdEvents(page({ "@type": "Event", name: "Late show", startDate: "2026-10-10T03:30:00Z", location: place("Tubby's", "Kingston") }));
  assert.deepEqual([e.date, e.time], ["2026-10-09", "11:30 PM"]);
});

test("other states' promoted events and online events are skipped", () => {
  const events = extractJsonLdEvents(page({ "@type": "ItemList", itemListElement: [
    { item: { "@type": "Event", name: "LA show", startDate: "2026-10-09", location: place("Venue", "Los Angeles", "CA") } },
    { item: { "@type": "Event", name: "Webinar", startDate: "2026-10-09", eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode" } },
    { item: { "@type": "Event", name: "Hoedown", startDate: "2026-10-10", location: place("Maple Shade", "Delhi") } },
  ] }));
  assert.deepEqual(events.map((e) => e.name), ["Hoedown"]);
});

test("broken blocks, non-events and events without a name or date are ignored", () => {
  const events = extractJsonLdEvents(page(
    "{ not json",
    { "@type": "Organization", name: "AllEvents" },
    { "@type": "Event", name: "", startDate: "2026-10-09" },
    { "@type": "Event", name: "No date" },
    { "@type": "Event", name: "Ok", startDate: "2026-10-11", location: place("Hall", "HUDSON") },
  ));
  assert.deepEqual(events.map((e) => [e.name, e.town]), [["Ok", "Hudson"]]);
});
