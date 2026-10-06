import * as cheerio from "cheerio";
import { fetchPage } from "../fetch.mjs";
import { extractEvents } from "../openai.mjs";
import { parseHtml } from "../html.mjs";
import { cachedEvents } from "./cached.mjs";

const DAY_HEADERS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];

// Catskill Crew: the structured event listings start at a day header; trim the prose and
// promos before the earliest one.
function fromFirstDayHeader(body) {
  const starts = DAY_HEADERS.map((day) => body.indexOf(day)).filter((i) => i > 0);
  return starts.length ? body.slice(Math.min(...starts)) : body;
}

// A Beehiiv newsletter's two latest issues: this week's events may be split across them.
export async function readNewsletter(source, { cache }) {
  console.log(`\n[${source.name}] Discovering latest issue...`);
  const archiveHtml = await fetchPage(source.discoverUrl);
  if (!archiveHtml) {
    console.log(`  ✗ Failed to fetch archive`);
    return [];
  }

  const $ = cheerio.load(archiveHtml);
  const links = [...new Set($("a[href*='/p/']").map((_, el) => $(el).attr("href")).get().filter(Boolean))];
  if (!links.length) {
    console.log(`  ✗ No issue links found`);
    return [];
  }

  const events = [];
  for (const link of links.slice(0, 2)) {
    const issueUrl = new URL(link, source.discoverUrl).href;
    events.push(...await cachedEvents(cache, issueUrl, {
      name: source.name,
      sourceUrl: issueUrl,
      read: async () => {
        console.log(`  Fetching: ${issueUrl}`);
        const issueHtml = await fetchPage(issueUrl);
        if (!issueHtml) throw new Error(`Failed to fetch ${issueUrl}`);
        const { pageTitle, h1, body } = parseHtml(issueHtml, issueUrl);
        return extractEvents(fromFirstDayHeader(body), source.name, { pageTitle, h1 });
      },
    }).catch((err) => {
      console.log(`  ✗ ${err.message}`);
      return [];
    }));
  }
  return events;
}
