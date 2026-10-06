import test from "node:test";
import assert from "node:assert/strict";
import { mentionsForPosts, resolveTaggedPlaces, taggedPlaceLines } from "./tagged.mjs";
import { formatPostsForLLM } from "./instagram.mjs";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const post = { id: "p1", caption: "Next Women's Self-Defense course starts in two weeks! 👊 crcinarkville" };

test("mentions are extracted once per post and cached", async () => {
  const cache = {};
  let calls = 0;
  const extractMentions = async (captions) => { calls++; return captions.map(() => ["@CRCinArkville."]); };
  const first = await mentionsForPosts([post], { extractMentions, cache, now: NOW });
  assert.deepEqual(first.get(post), ["crcinarkville"]);
  await mentionsForPosts([post], { extractMentions, cache, now: NOW });
  assert.equal(calls, 1);
});

test("tagged accounts resolve to places from name, bio and handle; non-places are cached as null", async () => {
  const cache = {};
  const asked = [];
  const places = await resolveTaggedPlaces(["crcinarkville", "someband"], {
    cache, now: NOW,
    lookupProfile: async (h) => (h === "crcinarkville" ? { name: "Catskill Recreation Center", biography: "Become a member, join a class or donate!" } : null),
    askPlaces: async (accounts) => {
      asked.push(...accounts);
      return accounts.map((a) => (a.handle === "crcinarkville"
        ? { isPlace: true, venue: "Catskill Recreation Center", town: "Arkville", state: "NY" }
        : { isPlace: false }));
    },
  });
  assert.equal(asked[0].name, "Catskill Recreation Center");
  assert.deepEqual(places.get("crcinarkville"), { name: "Catskill Recreation Center", town: "Arkville", state: "NY" });
  assert.equal(places.has("someband"), false);
  assert.equal(cache["instagram-place:someband"].events, null);
  assert.deepEqual(taggedPlaceLines(["crcinarkville", "someband"], places), ["@crcinarkville = Catskill Recreation Center, Arkville, NY"]);
});

test("new lookups stop at the run's budget, and failures aren't cached", async () => {
  const cache = {};
  const budget = { remaining: 1 };
  let lookups = 0;
  await resolveTaggedPlaces(["a", "b"], {
    cache, now: NOW, budget,
    lookupProfile: async () => { lookups++; throw new Error("rate limited"); },
    askPlaces: () => assert.fail("nothing to ask"),
  });
  assert.equal(lookups, 1);
  assert.deepEqual(cache, {});
});

test("tagged places are part of the post text sent to the extractor", () => {
  const text = formatPostsForLLM([{ ...post, taggedPlaces: ["@crcinarkville = Catskill Recreation Center, Arkville, NY"] }]);
  assert.match(text, /Tagged places: @crcinarkville = Catskill Recreation Center, Arkville, NY/);
});
