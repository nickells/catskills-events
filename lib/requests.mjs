// Venue requests. The Sources page asks visitors for a missing venue's Instagram account, and
// api.mjs opens a `venue-request` GitHub issue for it (people with GitHub can also use the
// .github/ISSUE_TEMPLATE/add-venue.yml form). Each scrape vets open requests first, through
// discovery, then answers each one on its issue and closes it. A request discovery didn't get to
// (rate limit, source limit) stays open for the next run.

import { USERNAME_RE, instagramHandleFromUrl } from "./leads.mjs";
import { KNOWN_TOWNS, titleCase } from "./towns.mjs";

export const REQUEST_LABEL = "venue-request";
// Labels of the issue form's fields, as GitHub writes them into the issue body.
const HANDLE_FIELD = "Instagram account";
const TOWN_FIELD = "Town";
const NO_RESPONSE = "_No response_";
const MAX_REQUESTS = 100; // one page of GitHub's issue list; more would wait for the next run

// Issue forms write each answer under its label: "### Instagram account\n\n@barn_shows".
function formAnswer(body, label) {
  const sections = body.split(/^###\s+/m);
  const section = sections.find((s) => s.split("\n")[0].trim().toLowerCase() === label.toLowerCase());
  const value = section?.split("\n").slice(1).join("\n").trim();
  return value && value !== NO_RESPONSE ? value : "";
}

// "@Barn_Shows", "barn_shows" or "https://www.instagram.com/barn_shows/" → "barn_shows".
export function parseHandle(text) {
  const raw = text.trim();
  const handle = instagramHandleFromUrl(raw) || instagramHandleFromUrl(`https://${raw}`)
    || raw.replace(/^@/, "").replace(/\/+$/, "").toLowerCase();
  return USERNAME_RE.test(handle) ? handle : null;
}

// The town only counts if it's one the site knows, so a typo can't become a source's town.
export function parseVenueRequest(issue) {
  const body = issue.body || "";
  const town = formAnswer(body, TOWN_FIELD).toLowerCase();
  return {
    number: issue.number,
    handle: parseHandle(formAnswer(body, HANDLE_FIELD)),
    ...(KNOWN_TOWNS.has(town) && { town: titleCase(town) }),
  };
}

export async function fetchVenueRequests({ github }) {
  const issues = await github("GET", `issues?labels=${REQUEST_LABEL}&state=open&per_page=${MAX_REQUESTS}`);
  return issues.filter((issue) => !issue.pull_request).map(parseVenueRequest);
}

// The issue a request from the Sources page opens, written like the issue form so the scrape
// reads both the same way. What Meta showed goes above the answers, where the parser doesn't
// look; the account's name is in a code span so a "@" in it can't notify anyone on GitHub.
export function requestIssue(handle, profile) {
  const seen = profile
    ? `\`${(profile.name || profile.username).replace(/[`\n]/g, "'")}\` · ${profile.mediaCount} posts`
    : "Meta couldn't be checked";
  return {
    title: `Add a venue: @${handle}`,
    labels: [REQUEST_LABEL],
    body: [
      `Sent from the Sources page: https://instagram.com/${handle}/ (${seen})`, "",
      `### ${HANDLE_FIELD}`, "", `@${handle}`, "",
      `### ${TOWN_FIELD}`, "", NO_RESPONSE,
    ].join("\n"),
  };
}

// A visitor's request from the Sources page. Accounts Meta can't see are turned away with how
// to fix it, since the scrape could never read them; if Meta can't be reached the request is
// opened anyway and vetted later. Returns the HTTP status and the message to show.
export async function submitVenueRequest(text, { known, lookupProfile, github, log = console.log }) {
  const handle = parseHandle(String(text || ""));
  if (!handle) return { status: 400, message: "That doesn't look like an Instagram account. Try @yourvenue." };
  if (known.has(handle)) return { status: 200, message: `@${handle} is already on the site. Thanks!` };
  let profile;
  try {
    profile = lookupProfile ? await lookupProfile(handle) : undefined;
  } catch (error) {
    log(`Meta lookup failed for @${handle}: ${error.message}`);
  }
  if (profile === null) {
    return {
      status: 422,
      message: `We can't see @${handle}. Check the spelling. We can only read business and creator accounts; switching is free in Instagram's settings, under "Account type and tools".`,
    };
  }
  const issue = requestIssue(handle, profile);
  if (github) {
    const { number } = await github("POST", "issues", issue);
    log(`Opened #${number} for @${handle}`);
  } else {
    log(`No GitHub token; would have opened "${issue.title}"`);
  }
  return { status: 200, message: "Submitted, we'll work on it." };
}

const IF_WRONG = "If we got this wrong, reply here and we'll take a look.";
const REPLIES = {
  invalid: () => `We couldn't find an Instagram username in this request. Please open a new one with just the account, like @yourvenue.`,
  known: (h) => `@${h} is already one of our sources, so its events are on the site. Thanks!`,
  added: (h, town) => `Thanks! @${h} is now one of our sources${town ? ` (${town})` : ""}. Its events will show up from tomorrow's update.`,
  not_business: (h) => `We couldn't see @${h}. Check the spelling. We can only read business and creator accounts. Switching is free in Instagram's settings, under "Account type and tools". If you switch, open a new request.`,
  inactive: (h) => `@${h} hasn't posted in over a year, so there are no events for us to read yet. Open a new request once it's posting again.`,
  performer: (h) => `@${h} looks like a performer rather than a venue. We list performers' shows through the venues that host them.`,
  outside_region: (h) => `@${h} looks like it mostly hosts events outside the Catskills and Hudson Valley, which this site covers.`,
  unclear: (h) => `We couldn't tell from @${h}'s recent posts that it hosts public events in the Catskills or Hudson Valley.`,
};
const CLOSED_AS = { added: "completed", known: "completed" };

// The reply and how to close a request, or null if it is still waiting to be vetted.
export function answerFor(request, { known, decisions, accepted }) {
  if (!request.handle) return { outcome: "invalid", body: REPLIES.invalid() };
  if (known.has(request.handle)) return { outcome: "known", body: REPLIES.known(request.handle) };
  const decision = decisions[request.handle];
  if (!decision) return null;
  if (decision === "added") {
    const town = accepted.find((source) => source.handle === request.handle)?.town;
    return { outcome: "added", body: REPLIES.added(request.handle, town) };
  }
  const reply = REPLIES[decision] || REPLIES.unclear;
  return { outcome: decision, body: `${reply(request.handle)}\n\n${IF_WRONG}` };
}

export async function answerVenueRequests(requests, outcome, { github, log = console.log }) {
  for (const request of requests) {
    const answer = answerFor(request, outcome);
    if (!answer) continue;
    try {
      await github("POST", `issues/${request.number}/comments`, { body: answer.body });
      await github("PATCH", `issues/${request.number}`, { state: "closed", state_reason: CLOSED_AS[answer.outcome] || "not_planned" });
      log(`  Answered request #${request.number}${request.handle ? ` (@${request.handle})` : ""}: ${answer.outcome}`);
    } catch (error) {
      log(`  ✗ Couldn't answer request #${request.number}: ${error.message}`);
    }
  }
}

// A GitHub REST client for this repository, or null when not running in GitHub Actions.
export function createGitHub({ repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN, fetchImpl = fetch } = {}) {
  if (!repo || !token) return null;
  return async (method, path, body) => {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body && { "content-type": "application/json" }),
      },
      ...(body && { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    return response.json();
  };
}
