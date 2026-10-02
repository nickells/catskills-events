import test from "node:test";
import assert from "node:assert/strict";
import { fetchPage } from "./fetch.mjs";

const respond = (status, body = "") => ({ ok: status < 400, status, text: async () => body });
const sequence = (...steps) => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  };
  return { fetchImpl, calls };
};

test("retries a timeout or server error, then succeeds", async () => {
  const { fetchImpl, calls } = sequence(new Error("timeout"), respond(503), respond(200, "<html>"));
  assert.equal(await fetchPage("https://x", 10, { fetchImpl, delays: [0, 0] }), "<html>");
  assert.equal(calls.length, 3);
});

test("gives up after the last retry", async () => {
  const { fetchImpl, calls } = sequence(respond(502));
  assert.equal(await fetchPage("https://x", 10, { fetchImpl, delays: [0, 0] }), null);
  assert.equal(calls.length, 3);
});

test("does not retry a 404", async () => {
  const { fetchImpl, calls } = sequence(respond(404));
  assert.equal(await fetchPage("https://x", 10, { fetchImpl, delays: [0, 0] }), null);
  assert.equal(calls.length, 1);
});
