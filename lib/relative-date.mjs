import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { getTypeSafeApiKey } from "./typesafe-key.mjs";

const MODEL = "jev-latest";
const REVIEW_BELOW = 0.6;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const RELATIVE_DATE_RE = /\b(today|tonight|tomorrow|day after tomorrow|(?:this|next)\s+(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?))\b/i;
const DATE_QUESTIONS_VERSION = 1;

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
  const target = WEEKDAYS.indexOf(weekday);
  if (dayAnchor !== "weekday" || target < 0) return null;
  const current = anchor.getUTCDay();
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

export async function resolveInstagramRelativeDates(events, posts, cache = {}, {
  apiKey = getTypeSafeApiKey(),
  fetchImpl = fetch,
  wait = sleep,
  log = console.log,
  now = Date.now(),
} = {}) {
  const stats = { corrected: 0, unchanged: 0, cached: 0, skipped: 0 };
  const candidates = events.map((event) => ({ event, post: findPostForEvent(event, posts) }))
    .filter(({ post }) => post?.timestamp && RELATIVE_DATE_RE.test(post.caption || ""));
  if (!candidates.length) return stats;
  if (!apiKey) {
    stats.skipped = candidates.length;
    log(`    Jev relative-date check skipped for ${candidates.length} event(s): TYPESAFE_API_KEY is not set`);
    return stats;
  }

  for (let offset = 0; offset < candidates.length; offset += 5) {
    const batch = candidates.slice(offset, offset + 5).map(({ event, post }) => ({
      eventName: event.name,
      caption: String(post.caption || "").slice(0, 4000),
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
          criteria: { today: "today or tonight", tomorrow: "tomorrow", day_after: "the day after tomorrow", weekday: "a named weekday", none: "No relative date for this event" },
        };
        questions[`weekday_${index}`] = {
          type: "choice",
          instructions: `If ${role} names a weekday, which weekday is it?`,
          criteria: Object.fromEntries([...WEEKDAYS, "none"].map((day) => [day, null])),
        };
        questions[`offset_${index}`] = {
          type: "choice",
          instructions: `If ${role} names a weekday, how is its week qualified?`,
          criteria: { current: "this weekday or this coming weekday", next: "next weekday or weekday next week", bare: "weekday with no this/next qualifier", none: "No named weekday" },
        };
      }
      const body = JSON.stringify({ model: MODEL, state, questions });
      try {
        let response;
        for (let attempt = 0; attempt < 3; attempt++) {
          response = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body,
            signal: AbortSignal.timeout(20_000),
          });
          if (![429, 529].includes(response.status) || attempt === 2) break;
          await wait(1000 * 2 ** attempt);
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
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
      if (!validChoice(anchor, ["today", "tomorrow", "day_after", "weekday", "none"])) continue;
      const used = [anchor];
      if (anchor.choice === "weekday") {
        if (!validChoice(weekday, [...WEEKDAYS, "none"]) || !validChoice(weekOffset, ["current", "next", "bare", "none"])) continue;
        used.push(weekday, weekOffset);
      }
      if (Math.min(...used.map((answer) => answer.confidence)) < REVIEW_BELOW) {
        stats.skipped++;
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
