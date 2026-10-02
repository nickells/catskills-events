import test from "node:test";
import assert from "node:assert/strict";
import { assembleRelativeDate, findPostForEvent, resolveInstagramRelativeDates } from "./relative-date.mjs";

const choice = (value, confidence = 0.9) => ({ type: "choice", choice: value, confidence, probabilities: { [value]: 1 } });

test("calendar math anchors this and next weekday to the post date", () => {
  const thursday = "2026-09-17T23:30:00Z";
  assert.equal(assembleRelativeDate(thursday, "weekday", "wednesday", "current"), "2026-09-23");
  assert.equal(assembleRelativeDate(thursday, "weekday", "wednesday", "next"), "2026-09-23");
  assert.equal(assembleRelativeDate(thursday, "weekday", "wednesday", "bare"), "2026-09-23");
  const monday = "2026-09-14T12:00:00Z";
  assert.equal(assembleRelativeDate(monday, "weekday", "wednesday", "current"), "2026-09-16");
  assert.equal(assembleRelativeDate(monday, "weekday", "wednesday", "next"), "2026-09-23");
});

test("event-to-post matching accepts a post URL or case-insensitive event name", () => {
  const posts = [{ url: "post-1", caption: "THIS WEDNESDAY: Jazz Night" }];
  assert.equal(findPostForEvent({ url: "post-1" }, posts), posts[0]);
  assert.equal(findPostForEvent({ name: "Jazz Night" }, posts), posts[0]);
});

test("Jev reads relative parts and code corrects the date", async () => {
  const events = [{ name: "Jazz Night", date: "2026-09-16" }];
  const posts = [{ caption: "Jazz Night is this Wednesday", timestamp: "2026-09-17T12:00:00Z" }];
  const stats = await resolveInstagramRelativeDates(events, posts, {}, {
    apiKey: "test", log: () => {},
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      assert.equal(request.state.items[0].postedAt, posts[0].timestamp);
      return { ok: true, status: 200, json: async () => ({ model: "jev-test", answers: {
        anchor_0: choice("weekday"), weekday_0: choice("wednesday"), offset_0: choice("current"),
      } }) };
    },
  });
  assert.equal(events[0].date, "2026-09-23");
  assert.equal(stats.corrected, 1);
});

test("low confidence leaves the extracted date alone", async () => {
  const events = [{ name: "Jazz Night", date: "2026-09-23" }];
  const posts = [{ caption: "Jazz Night is this Wednesday", timestamp: "2026-09-17T12:00:00Z" }];
  await resolveInstagramRelativeDates(events, posts, {}, {
    apiKey: "test", log: () => {}, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ answers: {
      anchor_0: choice("weekday"), weekday_0: choice("wednesday"), offset_0: choice("current", 0.4),
    } }) }),
  });
  assert.equal(events[0].date, "2026-09-23");
});
