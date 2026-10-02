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
