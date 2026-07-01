import { chromium } from "playwright";

const LOGIN_MODAL_TIMEOUT_MS = 3000;
const NAV_TIMEOUT_MS = 30000;
const DELAY_BETWEEN_PROFILES_MS = 2000;

export async function scrapeInstagramProfiles(sources) {
  const proxyUrl = process.env.PROXY_URL;
  const launchOpts = { headless: true };
  if (proxyUrl) {
    // Format: username:password@host:port
    const atIdx = proxyUrl.lastIndexOf("@");
    const credentials = proxyUrl.slice(0, atIdx);
    const server = proxyUrl.slice(atIdx + 1);
    const colonIdx = credentials.indexOf(":");
    const username = credentials.slice(0, colonIdx);
    const password = credentials.slice(colonIdx + 1);
    launchOpts.proxy = { server: `http://${server}`, username, password };
    console.log(`  Using residential proxy via ${server}`);
  }

  const browser = await chromium.launch(launchOpts);

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "America/New_York",
    javaScriptEnabled: true,
  });

  // Mask headless fingerprints
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });
    window.chrome = { runtime: {} };
  });

  const results = [];

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const url = `https://www.instagram.com/${source.handle}/`;
    console.log(`  [${i + 1}/${sources.length}] @${source.handle}`);

    try {
      const posts = await scrapeProfile(context, url);
      console.log(`    → ${posts.length} posts with text`);
      results.push({ ...source, posts });
    } catch (err) {
      console.log(`    ✗ ${err.message}`);
      results.push({ ...source, posts: [] });
    }

    if (i < sources.length - 1) {
      await sleep(DELAY_BETWEEN_PROFILES_MS);
    }
  }

  await browser.close();
  return results;
}

async function scrapeProfile(context, url) {
  const page = await context.newPage();

  try {
    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: NAV_TIMEOUT_MS,
    });

    // Wait for post images to appear
    await page
      .locator("main article img, main img[alt]")
      .first()
      .waitFor({ timeout: NAV_TIMEOUT_MS })
      .catch(() => {});

    // Debug: log what Instagram actually returned
    const pageTitle = await page.title();
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 300));
    const imgCount = await page.evaluate(() => document.querySelectorAll("img").length);
    console.log(`    [debug] title="${pageTitle}" imgs=${imgCount} body="${bodyText.replace(/\n/g, " | ")}"`);

    // Dismiss login modal if it appears
    try {
      const closeBtn = page.locator('[aria-label="Close"]');
      await closeBtn.waitFor({ timeout: LOGIN_MODAL_TIMEOUT_MS });
      await closeBtn.click();
    } catch {
      // No modal, that's fine
    }

    // Extract alt text from all post images in the grid
    const posts = await page.evaluate(() => {
      const imgs = document.querySelectorAll("main article img, main a img");
      const seen = new Set();
      const results = [];

      for (const img of imgs) {
        const alt = img.alt || "";
        if (!alt || alt.length < 20) continue;
        // Skip profile pictures and non-post images
        if (alt.endsWith("'s profile picture")) continue;
        if (seen.has(alt)) continue;
        seen.add(alt);

        const link = img.closest("a[href]");
        const postUrl = link ? link.href : null;

        results.push({ alt, postUrl });
      }

      return results;
    });

    return posts;
  } finally {
    await page.close();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
