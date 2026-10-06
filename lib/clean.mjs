// The extraction model sometimes writes "null" as text instead of JSON null. Left as a
// string it reads as a real value: an Instagram event with town "null" never got its
// account's town and ended up with no location.
const NULLISH = /^\s*(null|undefined|none|n\/a)?\s*$/i;

export function cleanEvent(event) {
  for (const [key, value] of Object.entries(event)) {
    if (typeof value === "string" && NULLISH.test(value)) event[key] = null;
  }
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
