import * as cheerio from "cheerio";
import { extractJsonLdEvents } from "./jsonld.mjs";

// Venue websites publish their calendars in a few machine-readable shapes, read here without
// an LLM: Squarespace event collections (`?format=json`), The Events Calendar's WordPress API,
// and schema.org JSON-LD.
const DAY_MS = 24 * 60 * 60 * 1000;
const RECHECK_AFTER_DAYS = 60;
const MIN_EVENTS = 2;
const EVENT_PATH_RE = /\/(events?|calendar|happenings|shows|performances|schedule|whats-on|concerts|programs?)(\/|$|-)/i;
const TRIBE_PATH = "/wp-json/tribe/events/v1/events?per_page=50";
const checkKey = (host) => `calendar-check:${host}`;

const plain = (html) => cheerio.load(`<div>${html || ""}</div>`)("div").text().replace(/\s+/g, " ").trim();

function nyDateTime(ms) {
  const d = new Date(ms);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(d).map((p) => [p.type, p.value]),
  );
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York" });
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time };
}

// "19:30" → "7:30 PM"
function clockTime(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export function squarespaceEvents(json, pageUrl) {
  const items = json?.upcoming || (/^events/.test(json?.collection?.typeName || "") ? json.items : null) || [];
  return items.filter((item) => item.startDate && item.title).map((item) => {
    const location = item.location || {};
    return {
      name: plain(item.title),
      ...nyDateTime(item.startDate),
      venue: location.addressTitle || null,
      // "Mt Tremper, NY, 12457"
      town: location.addressLine2?.split(",")[0].trim() || null,
      description: plain(item.excerpt).slice(0, 200) || null,
      url: item.fullUrl ? new URL(item.fullUrl, pageUrl).href : null,
    };
  });
}

export function tribeEvents(json) {
  return (json?.events || [])
    .filter((e) => e.title && e.start_date && (!e.venue?.state || /^(NY|New York)$/i.test(e.venue.state)))
    .map((e) => ({
      name: plain(e.title),
      date: e.start_date.slice(0, 10),
      time: e.all_day ? null : clockTime(e.start_date.slice(11, 16)),
      venue: e.venue?.venue ? plain(e.venue.venue) : null,
      town: e.venue?.city || null,
      description: plain(e.description).slice(0, 200) || null,
      url: e.url || null,
    }));
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const squarespaceJsonUrl = (url) => `${url}${url.includes("?") ? "&" : "?"}format=json`;

// A calendar's events, with the source's venue and town filling what the listing leaves out.
export async function readCalendar(calendar, { fetchPage }) {
  let events = [];
  if (calendar.calendar === "squarespace") {
    events = squarespaceEvents(parseJson(await fetchPage(squarespaceJsonUrl(calendar.url))), calendar.url);
  } else if (calendar.calendar === "tribe") {
    events = tribeEvents(parseJson(await fetchPage(new URL(TRIBE_PATH, calendar.url).href)));
  } else if (calendar.calendar === "jsonld") {
    events = extractJsonLdEvents((await fetchPage(calendar.url)) || "");
  }
  return events.map((e) => ({ ...e, venue: e.venue || calendar.venue || null, town: e.town || calendar.town || null }));
}

// Same-site links that look like an events listing, shortest (most general) first.
export function eventPageLinks(html, site) {
  const $ = cheerio.load(html);
  const host = new URL(site).hostname;
  const links = new Set();
  $("a[href]").each((_, a) => {
    try {
      const url = new URL($(a).attr("href"), site);
      if (url.hostname === host && EVENT_PATH_RE.test(`${url.pathname}/`)) links.add(url.origin + url.pathname.replace(/\/$/, ""));
    } catch {}
  });
  return [...links].sort((a, b) => a.length - b.length).slice(0, 4);
}

// The site's machine-readable calendar with the most upcoming events, or null.
export async function detectCalendar(site, { fetchPage, today }) {
  const home = await fetchPage(site);
  if (!home) return null;
  const upcoming = (events) => events.filter((e) => e.date >= today).length;
  const found = [];
  if (/wp-content|wp-json/i.test(home)) {
    const count = upcoming(tribeEvents(parseJson(await fetchPage(new URL(TRIBE_PATH, site).href))));
    if (count) found.push({ url: site, calendar: "tribe", count });
  }
  const squarespace = /squarespace/i.test(home);
  for (const url of eventPageLinks(home, site)) {
    if (squarespace) {
      const count = upcoming(squarespaceEvents(parseJson(await fetchPage(squarespaceJsonUrl(url))), url));
      if (count) found.push({ url, calendar: "squarespace", count });
    }
    const html = await fetchPage(url);
    const count = html ? upcoming(extractJsonLdEvents(html)) : 0;
    if (count) found.push({ url, calendar: "jsonld", count });
  }
  const best = found.sort((a, b) => b.count - a.count)[0];
  return best?.count >= MIN_EVENTS ? best : null;
}

// Checks sites (from Instagram bios and organizer links) for a calendar, adding finds to the
// registry; they're read from the next run on. Sites without one are rechecked after 60 days.
export async function discoverCalendars({ sites, registry, cache, fetchPage, skipHosts = [], now = Date.now(), log = console.log, maxChecks = 40 }) {
  registry.calendars ??= [];
  const today = new Date(now).toISOString().slice(0, 10);
  const hostOf = (url) => new URL(url).hostname.replace(/^www\./, "");
  const known = new Set([...skipHosts, ...registry.calendars.map((c) => hostOf(c.url))]);
  const added = [];
  let checked = 0;
  for (const { site, venue, town, via } of sites) {
    const host = hostOf(site);
    if (known.has(host)) continue;
    known.add(host);
    const last = cache[checkKey(host)];
    if (last && now - last.ts < RECHECK_AFTER_DAYS * DAY_MS) continue;
    if (checked >= maxChecks) break;
    checked++;
    const found = await detectCalendar(site, { fetchPage, today });
    cache[checkKey(host)] = { ts: now, events: found ? found.calendar : null };
    if (!found) continue;
    const calendar = {
      name: venue || host,
      url: found.url,
      calendar: found.calendar,
      ...(venue && { venue }),
      ...(town && { town }),
      addedAt: today,
      foundVia: via,
    };
    registry.calendars.push(calendar);
    added.push(calendar);
    log(`  + ${found.url} (${found.calendar}, ${found.count} upcoming) — via ${via}`);
  }
  log(`  Calendars: ${checked} site(s) checked, ${added.length} added`);
  return added;
}
