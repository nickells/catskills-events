import test from "node:test";
import assert from "node:assert/strict";
import { findInstagramHandle, findOrganizerLeads, instagramHandleFromUrl, organizerSite } from "./leads.mjs";
import { addLeads, rankCandidates } from "./discover.mjs";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const quiet = () => {};

test("profile links name a handle; post and reel links don't", () => {
  assert.equal(instagramHandleFromUrl("https://www.instagram.com/Tettas.Market/?hl=en"), "tettas.market");
  assert.equal(instagramHandleFromUrl("https://www.instagram.com/p/DdkTVVqxv0Q/"), null);
  assert.equal(instagramHandleFromUrl("https://instagram.com/reel/abc"), null);
  assert.equal(instagramHandleFromUrl("https://example.com/instagram"), null);
});

test("organizer sites skip ticketing, social and listing platforms", () => {
  assert.equal(organizerSite("https://www.tubbyskingston.com/calendar/woodsist"), "https://www.tubbyskingston.com/");
  assert.equal(organizerSite("https://www.eventbrite.com/e/123"), null);
  assert.equal(organizerSite("https://app.arts-people.com/index.php?show=1"), null);
  assert.equal(organizerSite("https://www.facebook.com/spiralhousepark/posts/1"), null);
  assert.equal(organizerSite("not a url"), null);
});

test("a site's most-linked Instagram account is its own", () => {
  const html = `<a href="https://instagram.com/partner">x</a>
    <a href="https://www.instagram.com/redowlcollective/">ig</a><a href="https://instagram.com/redowlcollective">ig</a>
    <a href="https://www.instagram.com/p/xyz/">post</a>`;
  assert.equal(findInstagramHandle(html), "redowlcollective");
  assert.equal(findInstagramHandle("<p>no links</p>"), null);
});

test("organizer leads come from event links, fetching each site once and caching the answer", async () => {
  const cache = {};
  const fetched = [];
  const fetchPage = async (url) => {
    fetched.push(url);
    return url.includes("redowl") ? `<a href="https://instagram.com/redowlcollective">ig</a>` : "<p>none</p>";
  };
  const events = [
    { url: "https://www.redowlcollective.com/red-owl-flea", town: "Kingston" },
    { url: "https://www.redowlcollective.com/other" },
    { url: "https://www.instagram.com/tettas.market/", town: "Olivebridge" },
    { url: "https://quiet.example/event" },
    { url: "https://www.eventbrite.com/e/1" },
  ];
  const { leads, sites } = await findOrganizerLeads(events, { cache, fetchPage, now: NOW, log: quiet });
  assert.deepEqual(sites, [
    { site: "https://www.redowlcollective.com/", town: "Kingston" },
    { site: "https://quiet.example/", town: undefined },
  ]);
  assert.deepEqual(leads, [
    { handle: "tettas.market", site: "instagram.com", town: "Olivebridge" },
    { handle: "redowlcollective", site: "redowlcollective.com", town: "Kingston" },
  ]);
  assert.deepEqual(fetched, ["https://www.redowlcollective.com/", "https://quiet.example/"]);
  await findOrganizerLeads(events, { cache, fetchPage, now: NOW + 1000, log: quiet });
  assert.equal(fetched.length, 2);
});

test("leads skip known sources and rank ahead of mentions", () => {
  const tally = { popular: { sources: { a: "2026-10-01", b: "2026-10-01" }, mentions: 5 } };
  addLeads(tally, [{ handle: "redowlcollective", site: "redowlcollective.com", town: "Kingston" }, { handle: "Known", site: "k.com" }], new Set(["known"]), "2026-10-06");
  assert.deepEqual(rankCandidates(tally).map((c) => [c.handle, c.lead, c.town]), [
    ["redowlcollective", true, "Kingston"],
    ["popular", false, undefined],
  ]);
});

test("new sites past the per-run fetch limit wait for a later run", async () => {
  const fetched = [];
  const events = ["https://a.example/1", "https://b.example/1"].map((url) => ({ url }));
  await findOrganizerLeads(events, { cache: {}, fetchPage: async (url) => (fetched.push(url), ""), now: NOW, log: quiet, maxFetches: 1 });
  assert.deepEqual(fetched, ["https://a.example/"]);
});
