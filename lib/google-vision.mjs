import { readFileSync } from "node:fs";

const LOCAL_KEY_FILE = new URL("../gcloud_key", import.meta.url);

export function getGoogleVisionApiKey() {
  if (process.env.GOOGLE_VISION_API_KEY) return process.env.GOOGLE_VISION_API_KEY;
  try {
    const raw = readFileSync(LOCAL_KEY_FILE, "utf8").trim();
    return raw.includes("=") ? raw.slice(raw.indexOf("=") + 1).trim() : raw;
  } catch {
    return undefined;
  }
}

export async function detectTextInImage(image, {
  apiKey = getGoogleVisionApiKey(),
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) throw new Error("GOOGLE_VISION_API_KEY is not set");
  const content = Buffer.isBuffer(image) ? image.toString("base64") : image;
  const response = await fetchImpl("https://vision.googleapis.com/v1/images:annotate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({ requests: [{
      image: { content },
      features: [{ type: "TEXT_DETECTION", maxResults: 1 }],
      imageContext: { languageHints: ["en"] },
    }] }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    let detail = "";
    try {
      const errorBody = await response.json();
      detail = errorBody.error?.message ? `: ${errorBody.error.message}` : "";
    } catch {}
    throw new Error(`Google Vision returned HTTP ${response.status}${detail}`);
  }
  const result = (await response.json()).responses?.[0];
  if (result?.error) throw new Error(`Google Vision: ${result.error.message || "OCR failed"}`);
  return (result?.fullTextAnnotation?.text || result?.textAnnotations?.[0]?.description || "").trim();
}

export async function detectTextAtUrl(imageUrl, { fetchImpl = fetch, ...options } = {}) {
  const proxyUrl = process.env.PROXY_URL;
  const request = { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) CatskillsEvents/1.0" } };
  if (proxyUrl) {
    const { ProxyAgent } = await import("undici");
    request.dispatcher = new ProxyAgent(`http://${proxyUrl}`);
  }
  const imageResponse = await fetchImpl(imageUrl, request);
  if (!imageResponse.ok) throw new Error(`Image download failed: ${imageResponse.status}`);
  return detectTextInImage(Buffer.from(await imageResponse.arrayBuffer()), { fetchImpl, ...options });
}
