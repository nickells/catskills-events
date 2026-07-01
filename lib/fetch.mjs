const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export async function fetchPage(url, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

let _browser = null;

export async function fetchPageWithBrowser(url) {
  try {
    const { chromium } = await import("playwright");
    if (!_browser) _browser = await chromium.launch({ headless: true });
    const page = await _browser.newPage();
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      return await page.content();
    } finally {
      await page.close();
    }
  } catch (err) {
    console.log(`    ✗ Browser fetch failed: ${err.message.slice(0, 80)}`);
    return null;
  }
}

export async function closeBrowser() {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}
