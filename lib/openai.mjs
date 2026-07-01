import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function extractEvents(text, sourceName, { pageTitle, h1 } = {}) {
  // gpt-4o-mini handles 128k context, but keep it reasonable for cost/speed
  const trimmed = text.slice(0, 60_000);
  const today = new Date();
  const dateContext = today.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    max_tokens: 16384,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You extract events from web pages and newsletters. Today is ${dateContext}.

Return JSON with this shape:
{
  "events": [
    {
      "name": "Event Name",
      "date": "YYYY-MM-DD or null if unclear",
      "time": "7:00 PM" or null,
      "venue": "Venue Name" or null,
      "town": "Town Name" or null,
      "description": "One sentence description" or null,
      "url": "Direct link to the event or ticket page — look for markdown-style [text](url) links near each event" or null,
      "category": "music" | "food" | "culture" | "nature" | "community" | "nightlife" | "wellness" | "other"
    }
  ]
}

Rules:
- Only include events that a person would actually want to ATTEND IN PERSON. Skip board meetings, trustees meetings, staff meetings, library closures, administrative events, internal organizational business, webinars, and online-only events. Also skip ads, venue descriptions, and generic info.
- "time" must be a human-readable string like "7:00 PM" or null. Never return the string "null" — use actual JSON null if there is no time listed.
- For category: music = concerts, live bands, DJs, open mics, jam sessions, live performances of music. food = dinners, tastings, farmers markets, food festivals. culture = theater, readings, art exhibitions, film screenings, workshops, craft classes, book clubs, lectures, storytelling. nature = hikes, foraging, garden tours, wildlife, outdoor adventure. community = fundraisers, fairs, parades, celebrations, festivals, car shows. nightlife = parties, trivia, karaoke, comedy shows, drag shows. wellness = yoga, fitness, sound baths, meditation, tai chi, support groups.
- Never use "other" if one of the above categories fits. Live game performances (like Bit Brigade) are music. Improv is nightlife.
- STALE DATA CHECK: The page title and heading are provided. If they contain a year that is NOT ${today.getFullYear()} (e.g. "2016 Music Schedule", "Events 2023"), the page is outdated — return {"events": []} with NO events. Do not re-date old events to the current year.
- If dates on the page are clearly in the past (e.g. "March 2024"), skip those events.
- Only use the current year (${today.getFullYear()}) for events that genuinely have no year specified AND the page is not stale.
- When a source says "Tuesday 16th" or "Friday 19th", resolve relative to today's date. The CURRENT month is ${today.toLocaleString("en-US", { month: "long" })} ${today.getFullYear()}. Do not assume a future month unless the day-of-week only fits a future month.
- If multiple events are listed for the same date at the same venue, list them separately.
- Do NOT duplicate events. If the same event name appears with a venue and without, only include the version with the venue.`,
      },
      {
        role: "user",
        content: `Extract all events from this page (source: ${sourceName}).${pageTitle ? `\nPage title: "${pageTitle}"` : ""}${h1 ? `\nPage heading: "${h1}"` : ""}\n\n${trimmed}`,
      },
    ],
  });

  const VALID_CATEGORIES = new Set([
    "music", "food", "culture", "nature", "community", "nightlife", "wellness",
  ]);

  const CATEGORY_MAP = {
    "film": "culture", "art": "culture", "arts": "culture", "theater": "culture",
    "theatre": "culture", "workshop": "culture", "lecture": "culture",
    "reading": "culture", "exhibition": "culture", "literature": "culture",
    "comedy": "nightlife", "trivia": "nightlife", "drag": "nightlife",
    "party": "nightlife", "karaoke": "nightlife", "improv": "nightlife",
    "concert": "music", "live music": "music", "jam": "music", "dj": "music",
    "dining": "food", "brunch": "food", "tasting": "food", "market": "food",
    "hike": "nature", "hiking": "nature", "foraging": "nature", "garden": "nature",
    "yoga": "wellness", "fitness": "wellness", "meditation": "wellness",
    "festival": "community", "fundraiser": "community", "parade": "community",
    "fair": "community", "celebration": "community",
  };

  try {
    const parsed = JSON.parse(res.choices[0].message.content);
    const events = parsed.events || [];
    for (const e of events) {
      if (e.category && !VALID_CATEGORIES.has(e.category)) {
        e.category = CATEGORY_MAP[e.category.toLowerCase()] || "culture";
      }
    }
    return events;
  } catch {
    console.error(`  Failed to parse OpenAI response for ${sourceName}`);
    return [];
  }
}

export async function ocrEventImage(imageUrl, event) {
  const missing = [
    !event.date && "date",
    !event.venue && "venue",
    !event.town && "town",
    !event.time && "time",
  ].filter(Boolean);

  const today = new Date();
  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    max_tokens: 1024,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are reading an event flyer image to fill in missing details. Today is ${today.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}. The current year is ${today.getFullYear()}.

The event "${event.name}" is missing: ${missing.join(", ")}.

Read the image and return JSON with ONLY the missing fields:
${JSON.stringify(Object.fromEntries(missing.map((f) => [f, "extracted value or null"])), null, 2)}

Rules:
- "date" must be YYYY-MM-DD format. Use ${today.getFullYear()} if no year shown.
- "time" must be like "7:00 PM" or null.
- Only return fields that were listed as missing. Do not invent data — return null if the image doesn't contain the answer.`,
      },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageUrl, detail: "low" } },
        ],
      },
    ],
  });

  try {
    return JSON.parse(res.choices[0].message.content);
  } catch {
    return {};
  }
}

export async function resolveVenueTowns(venues) {
  if (!venues.length) return {};

  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are given a list of venue names or addresses in the Hudson Valley / Catskills region of New York State. Return a JSON object mapping each input to an object with "town" and "venueName".

- "town": the town/hamlet the venue is located in, or null if unknown.
- "venueName": if the input is a street address rather than a venue name, return the actual business/venue name at that address. Otherwise return null.

Example: {"Orpheum Performing Arts Center": {"town": "Hunter", "venueName": null}, "7 Old US Highway 209": {"town": "Stone Ridge", "venueName": "Lydia's Cafe"}}`,
      },
      {
        role: "user",
        content: JSON.stringify(venues),
      },
    ],
  });

  try {
    return JSON.parse(res.choices[0].message.content);
  } catch {
    return {};
  }
}
