// Venue requests from the Sources page (deployed on Railway). Checks the account with Meta and
// opens a `venue-request` issue for us to follow up on.
//   META_PAGE_TOKEN             the scrape's Meta token, for the business-account check
//   GITHUB_REPOSITORY           owner/name of this repository
//   GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY
//                               the "catskills-events submitter" GitHub App (Issues read/write,
//                               installed on this repository only), so issues are opened by its bot
// Without the GitHub ones it only logs the issue it would open (local testing).
import "dotenv/config";
import { createServer } from "node:http";
import { createAppAuth } from "@octokit/auth-app";
import registry from "./lib/discovered-sources.json" with { type: "json" };
import { INSTAGRAM_SOURCES } from "./lib/sources.mjs";
import { createMetaProfileLookup } from "./lib/instagram.mjs";
import { createGitHub, submitVenueRequest } from "./lib/requests.mjs";

const DEFAULT_PORT = 8787;
const PORT = Number(process.env.PORT) || DEFAULT_PORT;
const PATH = "/venue-request";
// The site, and serve.mjs for local testing.
const ALLOWED_ORIGINS = new Set(["https://catskills.events", "http://localhost:3333"]);
const HOUR_MS = 60 * 60 * 1000;
const REQUESTS_PER_IP_PER_HOUR = 5;
// Each request is a Meta lookup from the ~200 an hour the daily scrape also draws on.
const REQUESTS_PER_HOUR = 30;
const MAX_BODY_BYTES = 1024;

const known = new Set([...INSTAGRAM_SOURCES, ...registry.accepted].map((source) => source.handle.toLowerCase()));
const { GITHUB_REPOSITORY, GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY } = process.env;
// Installation tokens last an hour; the library caches each one and fetches the next.
const appAuth = GITHUB_APP_ID && GITHUB_APP_INSTALLATION_ID && GITHUB_APP_PRIVATE_KEY && createAppAuth({
  appId: GITHUB_APP_ID,
  installationId: GITHUB_APP_INSTALLATION_ID,
  // A key pasted on one line keeps its line breaks as "\n".
  privateKey: GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
});
const github = createGitHub({
  repo: GITHUB_REPOSITORY,
  getToken: appAuth && (async () => (await appAuth({ type: "installation" })).token),
});

// Connects to Meta on first use, and again after a failure (an expired token, a blip).
let meta;
function lookupProfile(handle) {
  meta ??= createMetaProfileLookup().catch((error) => {
    meta = undefined;
    throw error;
  });
  return meta.then((lookup) => lookup?.(handle));
}

// Requests in the last hour, overall and by IP. Kept in memory: a restart just resets them.
const recent = new Map();
function allow(key, limit, now) {
  const times = (recent.get(key) || []).filter((t) => now - t < HOUR_MS);
  if (times.length >= limit) return false;
  recent.set(key, [...times, now]);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of recent) if (times.every((t) => now - t >= HOUR_MS)) recent.delete(key);
}, HOUR_MS).unref();

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

createServer(async (req, res) => {
  const origin = req.headers.origin;
  const reply = (status, message) => {
    res.writeHead(status, {
      "content-type": "application/json",
      ...(ALLOWED_ORIGINS.has(origin) && { "access-control-allow-origin": origin, vary: "Origin" }),
    });
    res.end(JSON.stringify({ message }));
  };
  const { pathname } = new URL(req.url, "http://localhost");
  if (req.method === "GET" && pathname === "/") return reply(200, "ok");
  if (pathname !== PATH) return reply(404, "Not found");
  if (req.method === "OPTIONS") {
    res.writeHead(204, ALLOWED_ORIGINS.has(origin) ? {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "POST",
      "access-control-allow-headers": "content-type",
      vary: "Origin",
    } : {});
    return res.end();
  }
  if (req.method !== "POST") return reply(405, "Method not allowed");
  if (!ALLOWED_ORIGINS.has(origin)) return reply(403, "Not allowed");

  let input;
  try {
    input = JSON.parse(await readBody(req));
  } catch {
    return reply(400, "Bad request");
  }
  // A hidden field people never see: anything in it is a bot, told it worked so it moves on.
  if (input.website) return reply(200, "Submitted, we'll work on it.");
  const now = Date.now();
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress).split(",")[0].trim();
  if (!allow(`ip:${ip}`, REQUESTS_PER_IP_PER_HOUR, now) || !allow("all", REQUESTS_PER_HOUR, now)) {
    return reply(429, "Lots of requests right now. Try again in an hour.");
  }
  try {
    const { status, message } = await submitVenueRequest(input.handle, { known, lookupProfile, github });
    reply(status, message);
  } catch (error) {
    console.error(`Request failed: ${error.message}`);
    reply(502, "Something went wrong on our end. Try again later.");
  }
}).listen(PORT, () => console.log(`Venue requests on :${PORT}${PATH}${github ? "" : " (no GitHub App: dry run)"}`));
