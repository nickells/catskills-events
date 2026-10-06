import * as cheerio from "cheerio";

// Listings from calendars and newsletters link to the organizer's own site. Each organizer's
// Instagram goes to discovery and is vetted like any mention; the site is checked for a calendar.
const DAY_MS = 24 * 60 * 60 * 1000;
const SITE_RECHECK_DAYS = 30;
const USERNAME_RE = /^[a-z0-9._]{1,30}$/;
const IG_PATHS = new Set(["p", "reel", "reels", "explore", "stories", "tv", "accounts", "about", "developer", "legal", "share"]);
// A link to one of these names a ticketing, social or listing platform, not the organizer.
const PLATFORMS = [
  "eventbrite", "facebook.com", "fb.me", "fb.com", "instagram.com", "gofundme.com", "viewcy.com",
  "arts-people.com", "ticketmaster", "dice.fm", "tixr.com", "seetickets", "etix.com", "universe.com",
  "withfriends", "linktr.ee", "google.com", "goo.gl", "bit.ly", "beehiiv.com", "allevents.in",
  "chronogram.com", "hvny.info", "tockify.com", "square.site", "squareup.com", "youtube.com",
  "youtu.be", "tiktok.com", "x.com", "twitter.com", "ticketleap", "brownpapertickets", "showclix",
];

export function instagramHandleFromUrl(href) {
  try {
    const url = new URL(href);
    if (!/(^|\.)instagram\.com$/.test(url.hostname)) return null;
    const handle = url.pathname.split("/")[1]?.toLowerCase();
    return handle && USERNAME_RE.test(handle) && !IG_PATHS.has(handle) ? handle : null;
  } catch {
    return null;
  }
}

// The organizer's homepage for an event link, or null for platform links.
export function organizerSite(href) {
  try {
    const url = new URL(href);
    if (!/^https?:$/.test(url.protocol)) return null;
    const host = url.hostname.replace(/^www\./, "");
    if (PLATFORMS.some((platform) => host === platform || host.endsWith(`.${platform}`) || host.startsWith(`${platform}.`) || host.includes(`.${platform}.`))) return null;
    return `${url.protocol}//${url.hostname}/`;
  } catch {
    return null;
  }
}

// The Instagram account a site links to most (usually its header or footer icon).
export function findInstagramHandle(html) {
  const $ = cheerio.load(html);
  const counts = new Map();
  $("a[href*='instagram.com']").each((_, el) => {
    const handle = instagramHandleFromUrl($(el).attr("href"));
    if (handle) counts.set(handle, (counts.get(handle) || 0) + 1);
  });
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

// The organizers behind listed events: their sites ({ site, town }) and the Instagram accounts
// those sites link to ({ handle, site, town }). New sites are fetched up to maxFetches a run.
export async function findOrganizerLeads(events, { cache, fetchPage, now = Date.now(), log = console.log, maxFetches = 60 }) {
  const leads = new Map();
  const sites = new Map();
  for (const event of events) {
    const direct = instagramHandleFromUrl(event.url);
    if (direct) leads.set(direct, { site: "instagram.com", town: event.town || undefined });
    const site = !direct && organizerSite(event.url);
    if (site && !sites.has(site)) sites.set(site, event.town || undefined);
  }

  let fetched = 0;
  for (const [site, town] of sites) {
    const key = `lead-site:${site}`;
    let handle = cache[key] && now - cache[key].ts < SITE_RECHECK_DAYS * DAY_MS ? cache[key].events : undefined;
    if (handle === undefined) {
      if (fetched >= maxFetches) continue;
      const html = await fetchPage(site);
      fetched++;
      if (!html) continue;
      handle = findInstagramHandle(html);
      cache[key] = { ts: now, events: handle };
    }
    if (handle && !leads.has(handle)) leads.set(handle, { site: new URL(site).hostname.replace(/^www\./, ""), town });
  }
  log(`  ${sites.size} organizer site(s) (${fetched} fetched), ${leads.size} Instagram lead(s)`);
  return {
    leads: [...leads].map(([handle, info]) => ({ handle, ...info })),
    sites: [...sites].map(([site, town]) => ({ site, town })),
  };
}
