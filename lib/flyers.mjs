import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Flyer images for the flyer board, served from the site itself: Instagram's image URLs expire
// within days, and same-origin images can be drawn in WebGL without CORS. Each image is fetched
// once, the first run its post is seen (while its URL is still fresh), resized, and kept in
// output/flyers between runs; files no upcoming event uses are removed.

export const FLYER_DIR = "output/flyers";
const FLYER_WIDTH = 600;
const FLYER_QUALITY = 75;
const CONCURRENCY = 6;

const POST_URL_RE = /instagram\.com\/(?:[^/]+\/)?(?:p|reel|tv)\/([A-Za-z0-9_-]+)/;

// The post's shortcode, which names its flyer file; null for anything that isn't a post link.
export function shortcodeOf(url) {
  return String(url || "").match(POST_URL_RE)?.[1] || null;
}

// Shortcode -> image URL for every Instagram post kept in the scrape cache.
export function postImages(cache) {
  const images = new Map();
  for (const [key, entry] of Object.entries(cache)) {
    if (!key.startsWith("instagram-posts:")) continue;
    for (const post of entry?.events?.posts || []) {
      const code = shortcodeOf(post.url);
      if (code && post.displayUrl) images.set(code, post.displayUrl);
    }
  }
  return images;
}

// sharp needs Node 20.3+; on an older runtime the scrape still finishes, without new flyers.
let sharpLoad;
const loadSharp = () => (sharpLoad ??= import("sharp").then((m) => m.default));

export async function resizeToWebp(buffer) {
  const sharp = await loadSharp();
  return sharp(buffer).rotate().resize({ width: FLYER_WIDTH, withoutEnlargement: true }).webp({ quality: FLYER_QUALITY }).toBuffer();
}

async function fetchImage(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const exists = (path) => stat(path).then(() => true, () => false);

// Sets `image` (a site-relative path) on each event whose Instagram post has a flyer, downloading
// any not already kept, then deletes kept flyers that no event uses. Failures leave the event
// without an image; the board simply skips it.
export async function attachFlyers(events, images, {
  dir = FLYER_DIR,
  publicPath = FLYER_DIR, // where the site serves dir from, relative to the page
  fetchImpl = fetch,
  resize = resizeToWebp,
  log = console.log,
} = {}) {
  await mkdir(dir, { recursive: true });
  const stats = { kept: 0, downloaded: 0, failed: 0, missing: 0, removed: 0 };
  let canResize = true;
  if (resize === resizeToWebp) {
    try {
      await loadSharp();
    } catch (error) {
      canResize = false;
      log(`  ✗ New flyers skipped: sharp unavailable (${error.message.split("\n")[0].slice(0, 80)})`);
    }
  }
  const byCode = new Map();
  for (const event of events) {
    const code = shortcodeOf(event.url);
    if (code) byCode.set(code, [...(byCode.get(code) || []), event]);
  }

  const codes = [...byCode.keys()];
  let next = 0;
  async function worker() {
    while (next < codes.length) {
      const code = codes[next++];
      const file = `${code}.webp`;
      const path = join(dir, file);
      if (await exists(path)) stats.kept++;
      else if (!images.has(code) || !canResize) { stats.missing++; continue; }
      else {
        try {
          await writeFile(path, await resize(await fetchImage(images.get(code), fetchImpl)));
          stats.downloaded++;
        } catch (error) {
          stats.failed++;
          log(`    ✗ flyer ${code}: ${error.message.slice(0, 80)}`);
          continue;
        }
      }
      for (const event of byCode.get(code)) event.image = `${publicPath}/${file}`;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, codes.length) }, worker));

  const used = new Set(codes.map((code) => `${code}.webp`));
  for (const file of await readdir(dir)) {
    if (file.endsWith(".webp") && !used.has(file)) {
      await rm(join(dir, file));
      stats.removed++;
    }
  }
  log(`  ${stats.kept + stats.downloaded} flyers (${stats.downloaded} new, ${stats.kept} kept, ${stats.removed} removed`
    + `${stats.failed ? `, ${stats.failed} failed` : ""}${stats.missing ? `, ${stats.missing} without a stored image` : ""})`);
  return stats;
}
