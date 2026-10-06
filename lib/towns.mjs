import { readFileSync } from "node:fs";

// Coordinates of the region's towns, keyed by lowercase name.
export const TOWN_COORDS = JSON.parse(readFileSync(new URL("./town-coords.json", import.meta.url), "utf8"));
export const KNOWN_TOWNS = new Set(Object.keys(TOWN_COORDS));
