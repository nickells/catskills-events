import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { askJev, JEV_MODEL as MODEL } from "./jev.mjs";
import { getTypeSafeApiKey } from "./typesafe-key.mjs";

const REVIEW_BELOW = 0.6;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
// Weekday abbreviations count on their own: a week's lineup is often "Tues … Thur … Sat".
const RELATIVE_DATE_RE = /\b(today|tonight|tomorrow|day after tomorrow|weekend|(?:sun|mon|tues|wednes|thurs|fri|satur)day|mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)\b/i;
// v2: weekends and bare weekdays. v3: weekday abbreviations, and flyer text sent to Jev.
const DATE_QUESTIONS_VERSION = 3;

const MONTH_DAY_RE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/i;
const NUMERIC_DATE_RE = /\b\d{1,2}\/\d{1,2}\b/;
const ORDINAL_DAY_RE = /\b\d{1,2}(?:st|nd|rd|th)\b/i;

// True when the text names a calendar day ("Oct 3", "10/3", "the 10th"), not just a relative one.
export function hasExplicitDate(text) {
  const s = String(text || "");
  return MONTH_DAY_RE.test(s) || NUMERIC_DATE_RE.test(s) || ORDINAL_DAY_RE.test(s);
}

// Everything a post says about its date: the caption, the image description and the flyer's text.
export const postDateText = (post) => [post?.caption, post?.alt, post?.flyerText].filter(Boolean).join("\n");

function nyDate(timestamp) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(new Date(timestamp)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

export function assembleRelativeDate(timestamp, dayAnchor, weekday, weekOffset) {
  const anchor = nyDate(timestamp);
  if (dayAnchor === "today") return anchor.toISOString().slice(0, 10);
  if (dayAnchor === "tomorrow") {
    anchor.setUTCDate(anchor.getUTCDate() + 1);
    return anchor.toISOString().slice(0, 10);
  }
  if (dayAnchor === "day_after") {
    anchor.setUTCDate(anchor.getUTCDate() + 2);
    return anchor.toISOString().slice(0, 10);
  }
  const current = anchor.getUTCDay();
  // A weekend starts on its Saturday; "this weekend" posted on a Sunday is that day.
  if (dayAnchor === "weekend") {
    if (weekOffset === "next") anchor.setUTCDate(anchor.getUTCDate() - current + 7 + 6);
    else if (current !== 0) anchor.setUTCDate(anchor.getUTCDate() + 6 - current);
    return anchor.toISOString().slice(0, 10);
  }
  const target = WEEKDAYS.indexOf(weekday);
  if (dayAnchor !== "weekday" || target < 0) return null;
  // Event promotions use "this Wednesday" for the upcoming occurrence, even when
  // the post was published after Wednesday in the current calendar week.
  if (weekOffset === "current") anchor.setUTCDate(anchor.getUTCDate() + (target - current + 7) % 7);
  else if (weekOffset === "next") anchor.setUTCDate(anchor.getUTCDate() - current + 7 + target);
  else anchor.setUTCDate(anchor.getUTCDate() + (target - current + 7) % 7);
  return anchor.toISOString().slice(0, 10);
}

export function findPostForEvent(event, posts) {
  const name = String(event.name || "").toLowerCase();
  return posts.find((post) => post.url && post.url === event.url)
    || posts.find((post) => name && String(post.caption || "").toLowerCase().includes(name));
}

function validChoice(answer, options) {
  return answer?.type === "choice" && options.includes(answer.choice)
    && Number.isFinite(answer.confidence);
}

// Explicit dates in a post are taken as extracted; only relative ones go to Jev.
// Returns, as `anchored`, the events whose date is backed by a relative phrase (resolved in code,
// or kept when Jev couldn't be asked); clearUnanchoredDates leaves those alone.
export async function resolveInstagramRelativeDates(events, posts, cache = {}, {
  apiKey = getTypeSafeApiKey(),
  fetchImpl = fetch,
  wait = sleep,
  log = console.log,
  now = Date.now(),
} = {}) {
  const stats = { corrected: 0, unchanged: 0, cached: 0, skipped: 0, anchored: new Set() };
  const candidates = events.map((event) => ({ event, post: findPostForEvent(event, posts) }))
    .filter(({ post }) => post?.timestamp && RELATIVE_DATE_RE.test(postDateText(post))
      && !hasExplicitDate(postDateText(post)));
  for (const { event } of candidates) stats.anchored.add(event);
  if (!candidates.length) return stats;
  if (!apiKey) {
    stats.skipped = candidates.length;
    log(`    Jev relative-date check skipped for ${candidates.length} event(s): TYPESAFE_API_KEY is not set`);
    return stats;
  }

  for (let offset = 0; offset < candidates.length; offset += 5) {
    const batch = candidates.slice(offset, offset + 5).map(({ event, post }) => ({
      eventName: event.name,
      caption: postDateText(post).slice(0, 4000),
      postedAt: post.timestamp,
    }));
    const keys = batch.map((item) => "jev-relative-date:" + createHash("sha256")
      .update(JSON.stringify([MODEL, DATE_QUESTIONS_VERSION, item])).digest("hex"));
    const answers = new Array(batch.length);
    const missing = [];
    keys.forEach((key, index) => {
      if (cache[key]?.events) {
        answers[index] = cache[key].events;
        stats.cached++;
      } else missing.push(index);
    });

    if (missing.length) {
      const state = { items: batch };
      const questions = {};
      for (const index of missing) {
        const role = `the date of the event named \`${batch[index].eventName}\` in \`items[${index}].caption\``;
        questions[`anchor_${index}`] = {
          type: "choice",
          instructions: `Which relative day names ${role}? The post date in \`items[${index}].postedAt\` is the calendar anchor, not the date to extract.`,
          criteria: { today: "today or tonight", tomorrow: "tomorrow", day_after: "the day after tomorrow", weekday: "a named weekday, written out or abbreviated (\"Saturday\", \"Sat\"), including a day heading the event is listed under", weekend: "the word \"weekend\" itself, with no weekday named for this event", none: "No relative date for this event" },
        };
        questions[`weekday_${index}`] = {
          type: "choice",
          instructions: `If ${role} names a weekday, which weekday is it?`,
          criteria: Object.fromEntries([...WEEKDAYS, "none"].map((day) => [day, null])),
        };
        questions[`offset_${index}`] = {
          type: "choice",
          instructions: `If ${role} names a weekday or a weekend, how is its week qualified?`,
          criteria: { current: "qualified with \"this\" or \"this coming\"", next: "qualified with \"next\" or \"next week\"", bare: "no this/next qualifier, as in a day heading of a week's lineup", none: "No named weekday or weekend" },
        };
      }
      try {
        const result = await askJev(state, questions, { apiKey, fetchImpl, wait });
        for (const index of missing) {
          answers[index] = {
            anchor: result.answers?.[`anchor_${index}`],
            weekday: result.answers?.[`weekday_${index}`],
            offset: result.answers?.[`offset_${index}`],
          };
          cache[keys[index]] = { ts: now, events: answers[index], model: result.model };
        }
      } catch (error) {
        stats.skipped += missing.length;
        log(`    Jev relative-date check failed: ${error.message}`);
      }
    }

    for (const [index, parts] of answers.entries()) {
      if (!parts) continue;
      const { anchor, weekday, offset: weekOffset } = parts;
      if (!validChoice(anchor, ["today", "tomorrow", "day_after", "weekday", "weekend", "none"])) continue;
      const used = [anchor];
      if (anchor.choice === "weekday") {
        if (!validChoice(weekday, [...WEEKDAYS, "none"])) continue;
        used.push(weekday);
      }
      if (anchor.choice === "weekday" || anchor.choice === "weekend") {
        if (!validChoice(weekOffset, ["current", "next", "bare", "none"])) continue;
        used.push(weekOffset);
      }
      // The post names no calendar date, so a date Jev can't confirm is the extractor's guess.
      if (anchor.choice === "none" || Math.min(...used.map((answer) => answer.confidence)) < REVIEW_BELOW) {
        if (anchor.choice !== "none") stats.skipped++;
        stats.anchored.delete(candidates[offset + index].event);
        continue;
      }
      const resolved = assembleRelativeDate(batch[index].postedAt, anchor.choice, weekday?.choice, weekOffset?.choice);
      if (!resolved) continue;
      const event = candidates[offset + index].event;
      if (event.date !== resolved) {
        log(`    Jev date: ${event.name} — ${event.date || "unknown"} → ${resolved}`);
        event.date = resolved;
        stats.corrected++;
      } else stats.unchanged++;
    }
  }
  return stats;
}

// A post with no calendar date leaves the extractor guessing ("THIS WEEKEND" became a Thursday),
// so its date stands only when code resolved it. Cleared dates fall through to the site lookup.
export function clearUnanchoredDates(events, posts, anchored = new Set(), { log = console.log } = {}) {
  let cleared = 0;
  for (const event of events) {
    if (!event.date || anchored.has(event)) continue;
    const post = findPostForEvent(event, posts);
    if (!post || hasExplicitDate(postDateText(post))) continue;
    log(`    Unanchored date: ${event.name} — ${event.date} cleared (post names no calendar date)`);
    event.date = null;
    cleared++;
  }
  return cleared;
}
