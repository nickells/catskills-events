import test from "node:test";
import assert from "node:assert/strict";
import { assembleRelativeDate, clearUnanchoredDates, findPostForEvent, hasExplicitDate, resolveInstagramRelativeDates } from "./relative-date.mjs";

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

test("weekends resolve to their Saturday from the post date", () => {
  const monday = "2026-09-28T20:45:00Z";
  assert.equal(assembleRelativeDate(monday, "weekend", null, "current"), "2026-10-03");
  assert.equal(assembleRelativeDate(monday, "weekend", null, "bare"), "2026-10-03");
  assert.equal(assembleRelativeDate(monday, "weekend", null, "next"), "2026-10-10");
  assert.equal(assembleRelativeDate("2026-10-03T14:00:00Z", "weekend", null, "current"), "2026-10-03");
  assert.equal(assembleRelativeDate("2026-10-04T14:00:00Z", "weekend", null, "current"), "2026-10-04");
});

test("explicit dates are recognized in captions and flyer text", () => {
  for (const text of ["OCTOBER 3-4", "10/3 – RIVALS NY", "Sat, Oct. 10", "Saturday the 10th"]) assert.ok(hasExplicitDate(text), text);
  for (const text of ["THIS WEEKEND", "Join us Saturday at 7pm", "2 bands, 4 hours"]) assert.ok(!hasExplicitDate(text), text);
});

test("Jev resolves this weekend; a post with flyer dates is not asked", async () => {
  const events = [{ name: "Fall Festival", date: "2026-10-08" }, { name: "Harvest Fair", date: "2026-10-17" }];
  const posts = [
    { caption: "Fall Festival is THIS WEEKEND", timestamp: "2026-09-28T20:45:00Z" },
    { caption: "Harvest Fair this weekend", flyerText: "OCTOBER 17", timestamp: "2026-09-28T20:45:00Z" },
  ];
  const stats = await resolveInstagramRelativeDates(events, posts, {}, {
    apiKey: "test", log: () => {},
    fetchImpl: async (_url, init) => {
      assert.equal(JSON.parse(init.body).state.items.length, 1);
      return { ok: true, status: 200, json: async () => ({ answers: {
        anchor_0: choice("weekend"), weekday_0: choice("none"), offset_0: choice("current"),
      } }) };
    },
  });
  assert.equal(events[0].date, "2026-10-03");
  assert.equal(events[1].date, "2026-10-17");
  assert.ok(stats.anchored.has(events[0]));
});

test("a guessed date is cleared when the post names no date code could resolve", () => {
  const events = [
    { name: "Fall Festival", url: "p1", date: "2026-10-08" },
    { name: "Jazz Night", url: "p2", date: "2026-10-09" },
    { name: "Open Mic", url: "p3", date: "2026-10-10" },
  ];
  const posts = [
    { url: "p1", caption: "Our annual festival, coming soon!" },
    { url: "p2", caption: "Jazz Night", flyerText: "FRIDAY OCT 9" },
    { url: "p3", caption: "Open Mic this Saturday" },
  ];
  const cleared = clearUnanchoredDates(events, posts, new Set([events[2]]), { log: () => {} });
  assert.equal(cleared, 1);
  assert.deepEqual(events.map((e) => e.date), [null, "2026-10-09", "2026-10-10"]);
});
