import test from "node:test";
import assert from "node:assert/strict";
import { detectTextInImage } from "./google-vision.mjs";

test("sends image bytes to Google text detection and returns full text", async () => {
  const text = await detectTextInImage(Buffer.from("image bytes"), {
    apiKey: "test-key",
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://vision.googleapis.com/v1/images:annotate");
      assert.equal(init.headers["x-goog-api-key"], "test-key");
      const body = JSON.parse(init.body);
      assert.equal(body.requests[0].features[0].type, "TEXT_DETECTION");
      assert.equal(body.requests[0].image.content, Buffer.from("image bytes").toString("base64"));
      return { ok: true, status: 200, json: async () => ({ responses: [{ fullTextAnnotation: { text: "  JAZZ NIGHT\n7 PM  " } }] }) };
    },
  });
  assert.equal(text, "JAZZ NIGHT\n7 PM");
});

test("reports API and per-image OCR failures", async () => {
  await assert.rejects(
    detectTextInImage("base64", { apiKey: "test", fetchImpl: async () => ({ ok: false, status: 403 }) }),
    /HTTP 403/
  );
  await assert.rejects(
    detectTextInImage("base64", { apiKey: "test", fetchImpl: async () => ({ ok: true, json: async () => ({ responses: [{ error: { message: "bad image" } }] }) }) }),
    /bad image/
  );
});
