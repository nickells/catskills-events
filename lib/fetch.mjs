const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const RETRY_DELAYS_MS = [1_000, 4_000];

// Retries timeouts, network errors, 429s and 5xx; other 4xx responses fail immediately.
export async function fetchPage(url, timeoutMs = 10_000, { fetchImpl = fetch, delays = RETRY_DELAYS_MS } = {}) {
  for (let attempt = 0; ; attempt++) {
    let retryable = true;
    try {
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
        headers: { "User-Agent": USER_AGENT },
      });
      if (res.ok) return await res.text();
      retryable = res.status === 429 || res.status >= 500;
    } catch {}
    if (!retryable || attempt >= delays.length) return null;
    await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
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
