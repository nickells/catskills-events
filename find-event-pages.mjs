import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";

const VENUES_FILE = "./output/venues.json";
const OUTPUT_FILE = "./output/venues-with-events.json";

// Common paths where venues put their event listings
const EVENT_PATH_CANDIDATES = [
  "/events",
  "/calendar",
  "/whats-on",
  "/live-music",
  "/shows",
  "/schedule",
  "/upcoming",
  "/happenings",
  "/performances",
  "/music",
  "/entertainment",
];

// Keywords in page body that suggest an events page
const EVENT_KEYWORDS = [
  "upcoming events",
  "live music",
  "event calendar",
  "this week",
  "tonight",
  "doors open",
  "tickets",
  "admission",
  "cover charge",
  "suggested donation",
];

async function checkUrl(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) CatskillsEvents/1.0",
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();
    return html;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

function scoreEventPage(html) {
  const lower = html.toLowerCase();
  let score = 0;
  for (const kw of EVENT_KEYWORDS) {
    if (lower.includes(kw)) score++;
  }
  return score;
}

async function findEventPages() {
  const venues = JSON.parse(readFileSync(VENUES_FILE, "utf-8"));
  const withWebsite = venues.filter((v) => v.website);

  console.log(`Checking ${withWebsite.length} venues for event pages...\n`);

  const results = [];

  for (const venue of withWebsite) {
    const base = venue.website.replace(/\/+$/, "");
    console.log(`${venue.name} (${base})`);

    let bestPath = null;
    let bestScore = 0;

    for (const path of EVENT_PATH_CANDIDATES) {
      const url = base + path;
      const html = await checkUrl(url);

      if (html) {
        const score = scoreEventPage(html);
        if (score > bestScore) {
          bestScore = score;
          bestPath = path;
        }
        if (score >= 2) {
          console.log(`  ✓ ${path} (score: ${score})`);
        }
      }
    }

    // Also check the homepage itself — some small venues list events there
    const homepageHtml = await checkUrl(base);
    if (homepageHtml) {
      const homeScore = scoreEventPage(homepageHtml);
      if (homeScore > bestScore) {
        bestScore = homeScore;
        bestPath = "/";
      }
    }

    if (bestScore >= 2) {
      results.push({
        ...venue,
        eventPagePath: bestPath,
        eventPageUrl: base + (bestPath === "/" ? "" : bestPath),
        eventPageScore: bestScore,
      });
      console.log(`  → Best: ${bestPath} (score: ${bestScore})\n`);
    } else {
      console.log(`  ✗ No event page found\n`);
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Venues with event pages: ${results.length} / ${withWebsite.length}`);

  results.sort((a, b) => b.eventPageScore - a.eventPageScore);
  writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
  console.log(`Saved to ${OUTPUT_FILE}`);
}

findEventPages().catch(console.error);
