import { setTimeout as sleep } from "node:timers/promises";
import { getTypeSafeApiKey } from "./typesafe-key.mjs";

export const JEV_MODEL = "jev-latest";

// One TypeSafe request with bounded retries on rate limits; throws on any other failure.
export async function askJev(state, questions, {
  apiKey = getTypeSafeApiKey(),
  fetchImpl = fetch,
  wait = sleep,
} = {}) {
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set");
  const body = JSON.stringify({ model: JEV_MODEL, state, questions });
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (![429, 529].includes(response.status) || attempt === 2) break;
    await wait(1000 * 2 ** attempt);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
