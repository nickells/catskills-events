import { readFileSync } from "node:fs";

const LOCAL_KEY_FILE = new URL("../openai_key", import.meta.url);

function valueFromFile(url) {
  const raw = readFileSync(url, "utf8").trim();
  if (!raw.includes("\n") && !raw.startsWith("OPENAI_API_KEY=")) return raw;
  const line = raw.split(/\r?\n/).find((entry) => entry.startsWith("OPENAI_API_KEY="));
  return line?.slice(line.indexOf("=") + 1).trim().replace(/^['"]|['"]$/g, "");
}

export function getOpenAIApiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    return valueFromFile(LOCAL_KEY_FILE) || undefined;
  } catch {
    return undefined;
  }
}
