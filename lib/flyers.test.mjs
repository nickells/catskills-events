import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachFlyers, postImages, resizeToWebp, shortcodeOf } from "./flyers.mjs";

const quiet = () => {};
const withDir = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), "flyers-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};
const okImage = (bytes) => async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(bytes).buffer });

test("names flyers by the post's shortcode, for post, reel and account-prefixed links", () => {
  assert.equal(shortcodeOf("https://www.instagram.com/p/Dd32KS7FiW5/"), "Dd32KS7FiW5");
  assert.equal(shortcodeOf("https://www.instagram.com/reel/C-x_9y/?igsh=abc"), "C-x_9y");
  assert.equal(shortcodeOf("https://www.instagram.com/colonywoodstockny/p/Dd_cDKfjHtd/"), "Dd_cDKfjHtd");
  assert.equal(shortcodeOf("https://www.instagram.com/colonywoodstockny/"), null);
  assert.equal(shortcodeOf("https://allevents.in/kingston-ny/all"), null);
  assert.equal(shortcodeOf(null), null);
});

test("indexes stored Instagram posts by shortcode, ignoring other cache entries and imageless posts", () => {
  const images = postImages({
    "instagram-posts:a": { events: { posts: [
      { url: "https://www.instagram.com/p/AAA/", displayUrl: "https://cdn/a.jpg" },
      { url: "https://www.instagram.com/p/BBB/" },
    ] } },
    "instagram-posts:b": { events: { posts: [], notFound: true } },
    "instagram:a": { events: [{ url: "https://www.instagram.com/p/CCC/", displayUrl: "https://cdn/c.jpg" }] },
  });
  assert.deepEqual([...images], [["AAA", "https://cdn/a.jpg"]]);
});

test("downloads new flyers, keeps existing ones, and shares one file between a post's events", () => withDir(async (dir) => {
  await writeFile(join(dir, "KEPT.webp"), "old");
  const fetched = [];
  const events = [
    { name: "Show", url: "https://www.instagram.com/p/NEW/" },
    { name: "Same flyer, second date", url: "https://www.instagram.com/p/NEW/" },
    { name: "Already have it", url: "https://www.instagram.com/p/KEPT/" },
    { name: "Web event", url: "https://example.com/event" },
  ];
  const stats = await attachFlyers(events, new Map([["NEW", "https://cdn/new.jpg"], ["KEPT", "https://cdn/kept.jpg"]]), {
    dir,
    fetchImpl: async (url) => { fetched.push(url); return okImage("jpeg bytes")(); },
    resize: async (buffer) => Buffer.concat([Buffer.from("webp:"), buffer]),
    log: quiet,
  });
  assert.deepEqual(fetched, ["https://cdn/new.jpg"]);
  assert.equal(await readFile(join(dir, "NEW.webp"), "utf8"), "webp:jpeg bytes");
  assert.equal(await readFile(join(dir, "KEPT.webp"), "utf8"), "old");
  assert.deepEqual(events.map((e) => e.image), ["output/flyers/NEW.webp", "output/flyers/NEW.webp", "output/flyers/KEPT.webp", undefined]);
  assert.deepEqual(stats, { kept: 1, downloaded: 1, failed: 0, missing: 0, removed: 0 });
}));

test("leaves events without an image when the download fails or no image is stored", () => withDir(async (dir) => {
  const events = [{ url: "https://www.instagram.com/p/GONE/" }, { url: "https://www.instagram.com/p/UNKNOWN/" }];
  const stats = await attachFlyers(events, new Map([["GONE", "https://cdn/expired.jpg"]]), {
    dir,
    fetchImpl: async () => ({ ok: false, status: 403 }),
    resize: async (buffer) => buffer,
    log: quiet,
  });
  assert.deepEqual(events.map((e) => e.image), [undefined, undefined]);
  assert.deepEqual(await readdir(dir), []);
  assert.equal(stats.failed, 1);
  assert.equal(stats.missing, 1);
}));

test("removes kept flyers that no upcoming event uses", () => withDir(async (dir) => {
  await writeFile(join(dir, "PAST.webp"), "x");
  await writeFile(join(dir, "STILL.webp"), "x");
  await writeFile(join(dir, ".gitkeep"), "");
  const stats = await attachFlyers([{ url: "https://www.instagram.com/p/STILL/" }], new Map(), { dir, log: quiet });
  assert.deepEqual((await readdir(dir)).sort(), [".gitkeep", "STILL.webp"]);
  assert.equal(stats.removed, 1);
}));

test("serves images from the configured public path", () => withDir(async (dir) => {
  const events = [{ url: "https://www.instagram.com/p/X/" }];
  await attachFlyers(events, new Map([["X", "https://cdn/x.jpg"]]), {
    dir, publicPath: "flyers", fetchImpl: okImage("x"), resize: async (b) => b, log: quiet,
  });
  assert.equal(events[0].image, "flyers/X.webp");
}));

test("resizes to a 600px-wide WebP without enlarging small images", async () => {
  const { default: sharp } = await import("sharp");
  const big = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#ff3fa4" } }).jpeg().toBuffer();
  const small = await sharp({ create: { width: 320, height: 400, channels: 3, background: "#0078bf" } }).png().toBuffer();
  const out = await sharp(await resizeToWebp(big)).metadata();
  assert.deepEqual([out.format, out.width, out.height], ["webp", 600, 750]);
  assert.equal((await sharp(await resizeToWebp(small)).metadata()).width, 320);
});
