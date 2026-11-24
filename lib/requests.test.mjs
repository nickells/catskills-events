import test from "node:test";
import assert from "node:assert/strict";
import { answerFor, answerVenueRequests, createGitHub, fetchVenueRequests, parseHandle, parseVenueRequest, requestIssue, submitVenueRequest } from "./requests.mjs";

// How GitHub writes an add-venue.yml submission into the issue body.
const formBody = (handle, town = "_No response_") => `### Instagram account\n\n${handle}\n\n### Town\n\n${town}`;
const quiet = () => {};

test("handles are read from @names, bare names and profile links", () => {
  assert.equal(parseHandle("@Barn_Shows"), "barn_shows");
  assert.equal(parseHandle(" barn.shows "), "barn.shows");
  assert.equal(parseHandle("https://www.instagram.com/barn_shows/?hl=en"), "barn_shows");
  assert.equal(parseHandle("instagram.com/barn_shows"), "barn_shows");
  assert.equal(parseHandle("our venue on insta"), null);
  assert.equal(parseHandle(""), null);
});

test("a request keeps its town only when the site knows it", () => {
  assert.deepEqual(parseVenueRequest({ number: 4, body: formBody("@barn_shows", "phoenicia") }), { number: 4, handle: "barn_shows", town: "Phoenicia" });
  assert.deepEqual(parseVenueRequest({ number: 5, body: formBody("@barn_shows", "Narnia") }), { number: 5, handle: "barn_shows" });
  assert.deepEqual(parseVenueRequest({ number: 6, body: formBody("@barn_shows") }), { number: 6, handle: "barn_shows" });
  assert.deepEqual(parseVenueRequest({ number: 7, body: null }), { number: 7, handle: null });
});

test("each request gets the reply for its outcome, or waits if it wasn't vetted", () => {
  const outcome = {
    known: new Set(["old_friend"]),
    decisions: { barn_shows: "added", solo_singer: "performer", private_person: "not_business", vague: "low_confidence" },
    accepted: [{ handle: "barn_shows", town: "Phoenicia" }],
  };
  const answer = (handle) => answerFor({ number: 1, handle }, outcome);
  assert.equal(answer(null).outcome, "invalid");
  assert.equal(answer("old_friend").outcome, "known");
  assert.match(answer("barn_shows").body, /@barn_shows is now one of our sources \(Phoenicia\)/);
  assert.match(answer("solo_singer").body, /performer[\s\S]*reply here/);
  assert.match(answer("private_person").body, /business and creator accounts/);
  assert.match(answer("vague").body, /couldn't tell/);
  assert.equal(answer("not_reached_yet"), null);
});

test("answered requests are commented on and closed; unvetted ones are left open", async () => {
  const calls = [];
  const github = async (method, path, body) => calls.push([method, path, body]);
  await answerVenueRequests(
    [{ number: 1, handle: "barn_shows" }, { number: 2, handle: "solo_singer" }, { number: 3, handle: "later" }],
    { known: new Set(), decisions: { barn_shows: "added", solo_singer: "performer" }, accepted: [{ handle: "barn_shows" }] },
    { github, log: quiet },
  );
  assert.deepEqual(calls.map(([method, path, body]) => [method, path, body.state_reason]), [
    ["POST", "issues/1/comments", undefined], ["PATCH", "issues/1", "completed"],
    ["POST", "issues/2/comments", undefined], ["PATCH", "issues/2", "not_planned"],
  ]);
});

test("a failed reply doesn't stop the others", async () => {
  const closed = [];
  const github = async (method, path) => {
    if (path === "issues/1/comments") throw new Error("HTTP 500");
    if (method === "PATCH") closed.push(path);
  };
  await answerVenueRequests([{ number: 1, handle: null }, { number: 2, handle: null }], { known: new Set(), decisions: {}, accepted: [] }, { github, log: quiet });
  assert.deepEqual(closed, ["issues/2"]);
});

test("open labeled issues are read as requests, skipping pull requests", async () => {
  let asked;
  const github = async (method, path) => {
    asked = [method, path];
    return [{ number: 8, body: formBody("@barn_shows") }, { number: 9, body: "", pull_request: {} }];
  };
  assert.deepEqual(await fetchVenueRequests({ github }), [{ number: 8, handle: "barn_shows" }]);
  assert.deepEqual(asked, ["GET", "issues?labels=venue-request&state=open&per_page=100"]);
});

test("a request from the site opens an issue the scrape reads like a form submission", () => {
  const issue = requestIssue("barn_shows", { username: "barn_shows", name: "Barn `Shows` @owner", mediaCount: 40 });
  assert.equal(issue.title, "Add a venue: @barn_shows");
  assert.deepEqual(issue.labels, ["venue-request"]);
  assert.match(issue.body, /`Barn 'Shows' @owner` · 40 posts/);
  assert.deepEqual(parseVenueRequest({ number: 1, body: issue.body }), { number: 1, handle: "barn_shows" });
});

test("site requests: bad and known accounts are answered without Meta or GitHub", async () => {
  const options = { known: new Set(["old_friend"]), lookupProfile: () => assert.fail("looked up"), github: () => assert.fail("opened"), log: quiet };
  assert.equal((await submitVenueRequest("not an account!", options)).status, 400);
  assert.equal((await submitVenueRequest(undefined, options)).status, 400);
  assert.match((await submitVenueRequest("@Old_Friend", options)).message, /already on the site/);
});

test("site requests: accounts Meta can't see are turned away; others open an issue", async () => {
  const opened = [];
  const options = (lookupProfile) => ({
    known: new Set(), lookupProfile, log: quiet,
    github: async (method, path, body) => { opened.push([method, path, body.title]); return { number: 7 }; },
  });
  const personal = await submitVenueRequest("@my_diary", options(async () => null));
  assert.equal(personal.status, 422);
  assert.match(personal.message, /business and creator accounts/);
  assert.deepEqual(await submitVenueRequest("instagram.com/barn_shows", options(async (h) => ({ username: h, mediaCount: 3 }))),
    { status: 200, message: "Submitted, we'll work on it." });
  // Meta down: sent anyway, to be vetted by the scrape.
  assert.equal((await submitVenueRequest("@quiet_barn", options(async () => { throw new Error("rate limited"); }))).status, 200);
  assert.deepEqual(opened, [["POST", "issues", "Add a venue: @barn_shows"], ["POST", "issues", "Add a venue: @quiet_barn"]]);
});

test("site requests without a GitHub token only log the issue", async () => {
  const logged = [];
  const result = await submitVenueRequest("@barn_shows", { known: new Set(), lookupProfile: null, github: null, log: (line) => logged.push(line) });
  assert.equal(result.status, 200);
  assert.match(logged[0], /would have opened "Add a venue: @barn_shows"/);
});

test("the GitHub client exists only with a repository and token, and reports failures", async () => {
  assert.equal(createGitHub({ repo: undefined, token: "t" }), null);
  assert.equal(createGitHub({ repo: "o/r", token: undefined }), null);
  let request;
  const github = createGitHub({
    repo: "o/r", token: "t",
    fetchImpl: async (url, init) => { request = [url, init]; return { ok: init.method === "GET", status: 403, json: async () => [] }; },
  });
  await github("GET", "issues");
  assert.equal(request[0], "https://api.github.com/repos/o/r/issues");
  assert.equal(request[1].headers.authorization, "Bearer t");
  await assert.rejects(github("PATCH", "issues/1", { state: "closed" }), /HTTP 403/);
});
