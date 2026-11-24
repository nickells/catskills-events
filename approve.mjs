// Adds an approved venue request to lib/discovered-sources.json. Run by
// .github/workflows/approve-venue.yml when a `venue-request` issue is labeled `approved`, with the
// issue's number and body in ISSUE_NUMBER and ISSUE_BODY. Prints the reply for the issue and
// exits non-zero if the request can't be approved.
import { loadDiscoveredSources, saveDiscoveredSources } from "./lib/discover.mjs";
import { INSTAGRAM_SOURCES } from "./lib/sources.mjs";
import { approveRequest, parseVenueRequest } from "./lib/requests.mjs";

const request = parseVenueRequest({ number: Number(process.env.ISSUE_NUMBER), body: process.env.ISSUE_BODY });
const registry = loadDiscoveredSources();
const known = new Set([...INSTAGRAM_SOURCES, ...registry.accepted].map((source) => source.handle.toLowerCase()));
const { ok, message } = approveRequest(registry, request, { known, today: new Date().toISOString().slice(0, 10) });
if (ok) saveDiscoveredSources(registry);
console.log(message);
if (!ok) process.exitCode = 1;
