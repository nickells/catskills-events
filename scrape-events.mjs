import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";
import * as cheerio from "cheerio";

const VENUES_FILE = "./output/venues-with-events.json";
const OUTPUT_FILE = "./output/events.json";

// Regex patterns for finding dates in text
const DATE_PATTERNS = [
  // "June 18, 2026" or "Jun 18, 2026"
  /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,?\s*(\d{4}))?\b/gi,
  // "6/18/2026" or "6/18"
  /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g,
];

// Time patterns
const TIME_PATTERN =
  /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM))\s*[-–]\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM))\b/g;

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) CatskillsEvents/1.0",
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function extractEvents(html, venue) {
  const $ = cheerio.load(html);
  const events = [];

  // Strategy 1: Look for structured event markup (schema.org, microdata)
  $('[itemtype*="Event"], [typeof*="Event"]').each((_, el) => {
    const name =
      $(el).find('[itemprop="name"]').text().trim() ||
      $(el).find("h2, h3, h4").first().text().trim();
    const date =
      $(el).find('[itemprop="startDate"]').attr("content") ||
      $(el).find('[itemprop="startDate"]').text().trim();
    const description = $(el).find('[itemprop="description"]').text().trim();

    if (name) {
      events.push({ name, date, description, source: "structured" });
    }
  });

  // Strategy 2: Look for common event list patterns
  // Many WordPress event plugins use .tribe-events-list, .em-events, etc.
  const eventSelectors = [
    ".tribe-events-list .tribe-events-list-event",
    ".tribe-common-g-row",
    ".em-event",
    ".event-item",
    ".event-listing",
    ".events-list li",
    ".event-card",
    'article[class*="event"]',
    'div[class*="event-"]',
    ".squarespace-events .eventlist-event",
    ".sqs-events .eventlist-event",
    ".eventlist-event",
  ];

  for (const selector of eventSelectors) {
    $(selector).each((_, el) => {
      const name = $(el)
        .find(
          "h1, h2, h3, h4, .tribe-events-list-event-title, .event-title, .eventlist-title"
        )
        .first()
        .text()
        .trim();
      const dateEl = $(el).find(
        'time, .tribe-event-schedule-details, .event-date, .eventlist-meta-date, [class*="date"]'
      );
      const date = dateEl.attr("datetime") || dateEl.text().trim();
      const description = $(el).find("p, .description, .event-description").first().text().trim();

      if (name && !events.find((e) => e.name === name)) {
        events.push({
          name,
          date: date || null,
          description: description.slice(0, 300) || null,
          source: "css-pattern",
        });
      }
    });
  }

  // Strategy 3: Brute force — find headings near date-like text
  if (events.length === 0) {
    $("h2, h3, h4, h5, strong, b").each((_, el) => {
      const heading = $(el).text().trim();
      if (!heading || heading.length > 100) return;

      const surrounding =
        $(el).parent().text().trim() || $(el).next().text().trim();
      const hasDate = DATE_PATTERNS.some((p) => {
        p.lastIndex = 0;
        return p.test(surrounding);
      });

      if (hasDate && heading.length > 3) {
        const timeMatch = TIME_PATTERN.exec(surrounding);
        TIME_PATTERN.lastIndex = 0;

        const dateMatch = DATE_PATTERNS[0].exec(surrounding);
        DATE_PATTERNS[0].lastIndex = 0;

        if (!events.find((e) => e.name === heading)) {
          events.push({
            name: heading,
            date: dateMatch ? dateMatch[0] : null,
            time: timeMatch ? timeMatch[0] : null,
            description: null,
            source: "heading-near-date",
          });
        }
      }
    });
  }

  return events.map((e) => ({
    ...e,
    venue: venue.name,
    venueAddress: venue.address,
    venueUrl: venue.eventPageUrl,
  }));
}

async function scrapeAllEvents() {
  const venues = JSON.parse(readFileSync(VENUES_FILE, "utf-8"));
  console.log(`Scraping events from ${venues.length} venues...\n`);

  const allEvents = [];

  for (const venue of venues) {
    console.log(`${venue.name} — ${venue.eventPageUrl}`);
    const html = await fetchPage(venue.eventPageUrl);

    if (!html) {
      console.log(`  ✗ Failed to fetch\n`);
      continue;
    }

    const events = extractEvents(html, venue);
    console.log(`  → Found ${events.length} events\n`);
    allEvents.push(...events);
  }

  console.log(`\n--- Summary ---`);
  console.log(`Total events found: ${allEvents.length}`);
  console.log(`From ${venues.length} venues`);

  writeFileSync(OUTPUT_FILE, JSON.stringify(allEvents, null, 2));
  console.log(`Saved to ${OUTPUT_FILE}`);
}

scrapeAllEvents().catch(console.error);
