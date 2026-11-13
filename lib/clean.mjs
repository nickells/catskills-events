import { squashPlace } from "./places.mjs";


// The extraction model sometimes writes "null" as text instead of JSON null. Left as a
// string it reads as a real value: an Instagram event with town "null" never got its
// account's town and ended up with no location.
const NULLISH = /^\s*(null|undefined|none|n\/a)?\s*$/i;

// Listing sites tack the town onto titles: "Next Stop Comedy at Big Eddy! - Narrowsburg, NY".
const TOWN_TAIL = /\s+[-–—|]\s+[^-–—|]*,\s*(NY|New York)\W*$/i;

export function cleanEvent(event) {
  for (const [key, value] of Object.entries(event)) {
    if (typeof value === "string" && NULLISH.test(value)) event[key] = null;
  }
  if (typeof event.name === "string") event.name = event.name.replace(TOWN_TAIL, "") || event.name;
  return event;
}

const SMALL_WORDS = new Set(["of", "on", "the", "and"]);

// A town copied off a flyer in all caps ("SAUGERTIES") is title-cased so it groups with the
// rest; one already in mixed case is left as written.
export function townCase(town) {
  if (!town || (/[a-z]/.test(town) && /[A-Z]/.test(town))) return town;
  return town.toLowerCase().replace(/[a-z]+/g, (word, i) =>
    i > 0 && SMALL_WORDS.has(word) ? word : word[0].toUpperCase() + word.slice(1));
}

// "Closed for the Holiday", "Hotel & Restaurant CLOSED for Holiday", a bare "CLOSED". Not
// "Closed Course and Fans to Cheer!!" in a 5K's title.
const CLOSURE = /^[\w&' ]*\bclosed\b(\s+for\b|\W*$)/i;

// A venue's closing notice isn't an event, and it cancels whatever else is listed there that
// day: Wayside Cider's standing "Locals Night" on Thanksgiving.
export function dropClosures(events) {
  const closed = events.filter((e) => e.date && squashPlace(e.venue) && CLOSURE.test(e.name || ""));
  const cancels = (closure, e) => {
    const [vc, ve] = [squashPlace(closure.venue), squashPlace(e.venue)];
    return e.date === closure.date && ve && (vc.includes(ve) || ve.includes(vc));
  };
  return events.filter((e) => !CLOSURE.test(e.name || "") && !closed.some((c) => cancels(c, e)));
}
