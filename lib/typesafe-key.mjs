import { readFileSync } from "node:fs";

const LOCAL_KEY_FILE = new URL("../jev-key", import.meta.url);

export function getTypeSafeApiKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try {
    const raw = readFileSync(LOCAL_KEY_FILE, "utf8").trim();
    return raw.includes("=") ? raw.slice(raw.indexOf("=") + 1).trim() : raw;
  } catch {
    return undefined;
  }
}
