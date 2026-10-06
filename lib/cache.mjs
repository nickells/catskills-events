import { readFileSync, writeFileSync, existsSync } from "node:fs";

export const DEFAULT_TTL_MS = 20 * 60 * 60 * 1000; // 20 hours

// The scrape cache: one JSON object of { ts, events } entries, shared by every stage and
// restored between CI runs. `data` is the raw object the lib modules read and write.
export function openCache(file) {
  const data = existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) : {};
  return {
    data,
    get(key, ttl = DEFAULT_TTL_MS) {
      const entry = data[key];
      return entry && Date.now() - entry.ts <= ttl ? entry.events : null;
    },
    set(key, events) {
      data[key] = { ts: Date.now(), events };
    },
    save() {
      writeFileSync(file, JSON.stringify(data, null, 2));
    },
  };
}
