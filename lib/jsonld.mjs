// Events from a page's schema.org JSON-LD. Listing sites like AllEvents and Eventbrite publish
// every event on a town page this way (name, date, venue, address), so there's nothing for an
// LLM to read, miss or misplace: one long page in one prompt found ~10% of AllEvents' events.

const SCRIPT_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

// Every Event-typed node, wherever the page nests it (top level, arrays, ItemList, @graph).
function* eventNodes(node) {
  if (Array.isArray(node)) {
    for (const n of node) yield* eventNodes(n);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (/Event$/.test([].concat(node["@type"] || "").join(" "))) {
    yield node;
    return;
  }
  for (const key of ["itemListElement", "@graph", "item"]) {
    if (node[key]) yield* eventNodes(node[key]);
  }
}

// "2026-10-09" → date only; "2026-10-09T19:00:00-04:00" → date and time, in the Catskills.
function parseStart(startDate) {
  if (!startDate) return { date: null, time: null };
  const value = String(startDate);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value, time: null };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { date: value.slice(0, 10), time: null };
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(d).map((p) => [p.type, p.value]),
  );
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York" });
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time };
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
// Some sites HTML-escape their JSON-LD ("Q&amp;A", "&#8211;").
const decode = (v) => v.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
  const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return Number.isFinite(code) ? String.fromCodePoint(code) : m;
});
const text = (v) => (typeof v === "string" ? decode(v).replace(/\s+/g, " ").trim() : "") || null;
// Some listings shout the town ("HUDSON"); title-case those, leave others as written.
const townName = (v) => {
  const t = text(v);
  return t && t === t.toUpperCase() && /[A-Z]/.test(t) ? t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : t;
};

export function extractJsonLdEvents(html) {
  const events = [];
  for (const [, body] of String(html).matchAll(SCRIPT_RE)) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      continue;
    }
    for (const e of eventNodes(data)) {
      const name = text(e.name);
      const { date, time } = parseStart(e.startDate);
      if (!name || !date) continue;
      const place = Array.isArray(e.location) ? e.location[0] : e.location;
      const address = typeof place?.address === "object" ? place.address : null;
      // Listing pages mix in other states' promoted events; keep New York and unknowns.
      const region = text(address?.addressRegion);
      if (region && !/^(NY|New York)$/i.test(region)) continue;
      if (/OnlineEventAttendanceMode/.test(String(e.eventAttendanceMode))) continue;
      events.push({
        name,
        date,
        time,
        venue: text(place?.name) || text(typeof place === "string" ? place : null),
        town: townName(address?.addressLocality),
        description: text(e.description)?.slice(0, 200) || null,
        url: text(e.url),
      });
    }
  }
  return events;
}
