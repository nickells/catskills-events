// Venue requests. The Sources page asks visitors for a missing venue's Instagram account, and
// api.mjs opens a `venue-request` GitHub issue for it (people with GitHub can also use the
// .github/ISSUE_TEMPLATE/add-venue.yml form). We follow up with the venue ourselves; labeling the
// issue `approved` adds the account (approve.mjs).

import { USERNAME_RE, instagramHandleFromUrl } from "./leads.mjs";
import { KNOWN_TOWNS, titleCase } from "./towns.mjs";

export const REQUEST_LABEL = "venue-request";
// Labels of the issue form's fields, as GitHub writes them into the issue body.
const HANDLE_FIELD = "Instagram account";
const TOWN_FIELD = "Town";
const NO_RESPONSE = "_No response_";

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

// The issue a request from the Sources page opens, written like the issue form so approving
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
// opened anyway, for us to check. Returns the HTTP status and the message to show.
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

// Adds a request we approved (by labeling its issue `approved`) to the discovered sources,
// without vetting: approving is the check. `known` holds every current source's handle.
export function approveRequest(registry, request, { known, today }) {
  if (!request.handle) return { ok: false, message: "Couldn't approve: no Instagram account found in this request." };
  if (known.has(request.handle)) return { ok: true, message: `@${request.handle} is already a source.` };
  registry.accepted.push({
    handle: request.handle,
    ...(request.town && { town: request.town }),
    addedAt: today,
    foundVia: [`request:#${request.number}`],
  });
  return { ok: true, message: `Added @${request.handle}. Its events show up from the next daily update.` };
}

// A GitHub REST client for this repository, or null without a repository and token. `getToken`
// is called for every request, so a GitHub App's hour-long tokens are renewed as they expire.
export function createGitHub({ repo, getToken, fetchImpl = fetch }) {
  if (!repo || !getToken) return null;
  return async (method, path, body) => {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await getToken()}`,
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
