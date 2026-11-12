import test from "node:test";
import assert from "node:assert/strict";
import { deduplicateEvents } from "./dedup.mjs";

const ev = (name, venue, town, source, extra = {}) => ({ name, date: "2026-10-08", venue, town, source, ...extra });

test("one event listed by several sources is merged", () => {
  const merged = deduplicateEvents([
    ev("Margaret Glaspy", "Assembly", "Kingston", "Chronogram"),
    ev("Margaret Glaspy", "Assembly Kingston", "Kingston, NY", "Instagram @assemblykingston", { time: "8:00 PM" }),
    ev("Margaret Glaspy live", null, "Kingston", "HVNY"),
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sources.sort(), ["Chronogram", "HVNY", "Instagram @assemblykingston"]);
  assert.equal(merged[0].time, "8:00 PM");
});

test("same-named events at different places stay separate", () => {
  const merged = deduplicateEvents([
    ev("Trivia Night", "Awestruck Sidney Taproom", "Sidney", "Instagram @awestruckciders"),
    ev("Trivia Night", "Phoenicia Diner", "Mt. Tremper", "Instagram @someone"),
    ev("Trivia Night", "Keegan Ales", "Kingston", "Chronogram"),
  ]);
  assert.equal(merged.length, 3);
  assert.equal(merged.find((e) => e.venue === "Awestruck Sidney Taproom").town, "Sidney");
});

test("same town, different venues: only a specific name merges", () => {
  const specific = deduplicateEvents([
    ev("Hudson Oktoberfest presented by Upper Depot Brewing", "Upper Depot Brewing", "Hudson", "Instagram @lastingjoybrewery"),
    ev("Hudson Oktoberfest presented by Upper Depot Brewing", "Basilica Hudson", "Hudson", "Chronogram"),
  ]);
  assert.equal(specific.length, 1);
  const generic = deduplicateEvents([
    ev("Open Mic", "Tubby's", "Kingston", "Instagram @tubbyskingston"),
    ev("Open Mic", "Rough Draft Bar & Books", "Kingston", "Instagram @roughdraftny"),
  ]);
  assert.equal(generic.length, 2);
});

test("the Instagram copy leads a merge, whichever source is seen first", () => {
  for (const order of [[0, 1], [1, 0]]) {
    const copies = [
      ev("Vintage & Antiques Sale", "Delhi Fairgrounds", "Delhi", "Great Western Catskills", {
        description: "Vintage and antiques sale, silver, porcelain, glass, paper ephemera and more from regional dealers.",
        url: "https://tockify.com/greatwesterncatskills/detail/5913/1791648000000",
      }),
      ev("Vintage & Antiques Sale", null, "Delhi", "Instagram @delhi.ny", {
        description: "Our fall sale is back! 40 dealers, hot cider, and a bake sale for the library.",
        url: "https://www.instagram.com/p/abc/",
        time: "10:00 AM",
      }),
    ];
    const [merged] = deduplicateEvents(order.map((i) => copies[i]));
    assert.equal(merged.description, "Our fall sale is back! 40 dealers, hot cider, and a bake sale for the library.");
    assert.equal(merged.url, "https://www.instagram.com/p/abc/");
    assert.equal(merged.time, "10:00 AM");
    // The listing still fills in what the post leaves out.
    assert.equal(merged.venue, "Delhi Fairgrounds");
    assert.deepEqual(merged.sources, ["Instagram @delhi.ny", "Great Western Catskills"]);
  }
});

test("one account's copies of an event merge despite punctuation and a wrong town", () => {
  const ig = "Instagram @livingstonmanorny";
  const merged = deduplicateEvents([
    ev("Very Scary Manor", "Livingston Legacy", "Livingston", ig, {
      time: "12:00 PM", description: "Join us for a day of spooktacular happenings.",
    }),
    ev("Very Scary Manor!", "Main Street and Pleasant Street", "Livingston Manor", ig, {
      time: "12:00 PM",
      description: "Join the Chamber of Commerce for an afternoon of fall food, local crafts, pumpkin painting, games and more!",
    }),
    ev("Very Scary Manor", "Livingston Manor", "Livingston Manor", ig, {
      description: "Join us for a new Halloween event with market vendors.",
    }),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].town, "Livingston Manor");
  assert.equal(merged[0].venue, "Main Street and Pleasant Street");
  assert.equal(merged[0].time, "12:00 PM");
  assert.match(merged[0].description, /Chamber of Commerce/);
});

test("listings of one show merge and keep the title naming the act", () => {
  const merged = deduplicateEvents([
    ev("Next Stop Comedy at Return Brewing Outpost! - Catskill, NY", "Return Brewing Outpost", "Catskill", "AllEvents.in", { time: "8:00 PM" }),
    ev("Next Stop Comedy Night", "Return Brewing", "Catskill", "Return Brewing", { time: "8:00 PM" }),
    ev("Next Stop Comedy: Giancarlo Biondino", "Return Brewing Outpost", "Catskill", "Instagram @returnoutpost", { time: "8 PM" }),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, "Next Stop Comedy: Giancarlo Biondino");
  assert.equal(merged[0].venue, "Return Brewing Outpost");
  assert.equal(merged[0].sources.length, 3);
});

test("unrelated events, or the same title at other times or places, stay separate", () => {
  const sameVenue = deduplicateEvents([
    ev("Next Stop Comedy Night", "Return Brewing Outpost", "Catskill", "Instagram @returnoutpost", { time: "8:00 PM" }),
    ev("Trivia Night", "Return Brewing Outpost", "Catskill", "Instagram @returnoutpost", { time: "8:00 PM" }),
    ev("Karaoke with DJ Sam", "Return Brewing Outpost", "Catskill", "Instagram @returnoutpost"),
  ]);
  assert.equal(sameVenue.length, 3);
  const otherTime = deduplicateEvents([
    ev("Next Stop Comedy", "Return Brewing Outpost", "Catskill", "AllEvents.in", { time: "6:00 PM" }),
    ev("Next Stop Comedy: Late Show", "Return Brewing Outpost", "Catskill", "AllEvents.in", { time: "9:00 PM" }),
  ]);
  assert.equal(otherTime.length, 2);
  const otherTown = deduplicateEvents([
    ev("Next Stop Comedy at Return Brewing! - Hudson, NY", "Return Brewing", "Hudson", "AllEvents.in", { time: "8:00 PM" }),
    ev("Next Stop Comedy: Giancarlo Biondino", "Return Brewing Outpost", "Catskill", "Instagram @returnoutpost", { time: "8:00 PM" }),
  ]);
  assert.equal(otherTown.length, 2);
});

test("a festival and a sub-event at another venue in town stay separate", () => {
  const merged = deduplicateEvents([
    ev("Dickens on the Delaware", "Callicoon, N.Y.", "Callicoon", "AllEvents.in"),
    ev("Dickens on Delaware Photo Sessions with Santa", "Western Inn", "Callicoon", "AllEvents.in"),
  ]);
  assert.equal(merged.length, 2);
});
