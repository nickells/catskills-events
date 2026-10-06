import { KNOWN_TOWNS } from "../towns.mjs";
import { cachedEvents } from "./cached.mjs";

const CATEGORIES = {
  "music": "music", "concert": "music", "live-music": "music", "jazz": "music", "bluegrass": "music",
  "food": "food", "drinks": "food", "cider": "food", "beer": "food", "market": "food", "farmers-market": "food",
  "art": "culture", "theater": "culture", "film": "culture", "workshop": "culture", "class": "culture",
  "pottery": "culture", "reading": "culture", "lecture": "culture", "history": "culture",
  "hike": "nature", "hiking": "nature", "outdoor": "nature", "garden": "nature", "nature": "nature",
  "fundraiser": "community", "festival": "community", "parade": "community", "fair": "community",
  "yoga": "wellness", "meditation": "wellness", "wellness": "wellness",
  "comedy": "nightlife", "trivia": "nightlife",
};

function category(tags) {
  for (const tag of tags) {
    const mapped = CATEGORIES[tag.toLowerCase()];
    if (mapped) return mapped;
  }
  return "community";
}

// Events from a Tockify API response, skipping online-only ones.
export function tockifyEvents(data, calendar) {
  return (data?.events || []).map((e) => {
    const c = e.content || {};
    const start = e.when?.start?.millis;
    const loc = c.location || {};
    const tags = c.tagset?.tags?.default || [];
    const name = c.summary?.text || "Unknown Event";
    return {
      name,
      date: start ? new Date(start).toISOString().slice(0, 10) : null,
      time: start ? new Date(start).toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York",
      }) : null,
      // The title names the venue when the place field is empty ("Locals Night at Wayside Cider").
      venue: c.place || name.match(/\bat\s+(.+)/i)?.[1].trim() || null,
      town: loc.c_locality || tags.find((t) => KNOWN_TOWNS.has(t.toLowerCase())) || null,
      description: c.description?.text?.slice(0, 200) || null,
      // A Tockify event page needs the occurrence (tid, its start in ms) as well as the event's
      // uid: recurring events share a uid, and /detail/<uid> alone is "We couldn't find that page".
      url: c.customButtonLink || `https://tockify.com/${calendar}/detail/${e.eid?.uid}/${e.eid?.tid ?? start}`,
      category: category(tags),
      _lat: loc.latitude || null,
      _lng: loc.longitude || null,
    };
  }).filter((e) => {
    const name = e.name.toLowerCase();
    return e.date && (!name.includes("online") || name.includes("from "));
  });
}

export function readTockify(source, { cache }) {
  return cachedEvents(cache, `tockify:${source.tockifyCalendar}`, {
    name: source.name,
    sourceUrl: source.url,
    read: async () => {
      console.log(`\n[${source.name}] Fetching Tockify API...`);
      const res = await fetch(`https://tockify.com/api/ngevent?calname=${source.tockifyCalendar}&max=100&startms=${Date.now()}`);
      if (!res.ok) throw new Error(`Tockify API returned ${res.status}`);
      return tockifyEvents(await res.json(), source.tockifyCalendar);
    },
  });
}
