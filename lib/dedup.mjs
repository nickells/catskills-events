export function deduplicateEvents(events) {
  // Pass 1: exact key match
  const byKey = new Map();
  for (const event of events) {
    const key = normalizeKey(event);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, event);
    } else {
      byKey.set(key, mergePair(existing, event));
    }
  }

  // Pass 2: fuzzy match — same date + similar name (ignoring venue differences)
  const result = [];
  const used = new Set();

  const entries = [...byKey.entries()];
  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue;
    let merged = entries[i][1];

    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(j)) continue;
      const other = entries[j][1];

      if (isFuzzyMatch(merged, other)) {
        merged = mergePair(merged, other);
        used.add(j);
      }
    }

    result.push(merged);
  }

  return result;
}

function normalizeKey(event) {
  const name = normalizeName(event.name);
  const date = event.date || "nodate";
  const venue = (event.venue || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 20);
  return `${date}::${venue}::${name}`;
}

function normalizeName(name) {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 40);
}

const squashPlace = (place) => (place || "")
  .toLowerCase()
  .replace(/,?\s*(ny|new york|usa)$/, "")
  .replace(/^\s*the\s+/, "")
  .replace(/[^a-z0-9]/g, "");

// Same-named events on one date are the same event only at compatible places. Otherwise a
// generic name merges across the region: one bar's "Trivia Night" took another's town.
function placesCompatible(a, b) {
  const [ta, tb] = [squashPlace(a.town), squashPlace(b.town)];
  const sameTown = ta && ta === tb;
  if (ta && tb && !sameTown) return false;
  const [va, vb] = [squashPlace(a.venue), squashPlace(b.venue)];
  if (!va || !vb || va.includes(vb) || vb.includes(va)) return true;
  // Venues written differently in the same town ("Upper Depot Brewing" / "Basilica Hudson")
  // still match when the name is specific enough to be one event.
  return sameTown && Math.min(normalizeName(a.name).length, normalizeName(b.name).length) >= 20;
}

function isFuzzyMatch(a, b) {
  // Must be on the same date
  if (!a.date || !b.date || a.date !== b.date) return false;
  if (!placesCompatible(a, b)) return false;

  const nameA = normalizeName(a.name);
  const nameB = normalizeName(b.name);

  // Exact name match (venue may differ or be missing)
  if (nameA === nameB) return true;

  // One name starts with the other (handles truncated names like "Neil Driscoll-'57 New Paintings...")
  if (nameA.startsWith(nameB) || nameB.startsWith(nameA)) return true;

  // High overlap: check if the shorter name is contained in the longer
  const [shorter, longer] = nameA.length <= nameB.length ? [nameA, nameB] : [nameB, nameA];
  if (shorter.length >= 10 && longer.includes(shorter)) return true;

  return false;
}

const sourcesOf = (event) => event.sources || (event.source ? [event.source] : []);
const fromInstagram = (event) => sourcesOf(event).some((source) => source.startsWith("Instagram @"));

// The Instagram copy of an event leads the merge: its name, description, post link and
// details come from the people running it, and are usually richer than a listing site's.
function mergePair(a, b) {
  const [lead, other] = fromInstagram(b) && !fromInstagram(a) ? [b, a] : [a, b];
  const sources = [...new Set([...sourcesOf(lead), ...sourcesOf(other)])];

  // Collect all sourceUrls keyed by source name
  const sourceUrls = { ...(other.sourceUrls || {}), ...(lead.sourceUrls || {}) };
  if (other.source && other.sourceUrl) sourceUrls[other.source] = other.sourceUrl;
  if (lead.source && lead.sourceUrl) sourceUrls[lead.source] = lead.sourceUrl;

  // Between two Instagram (or two non-Instagram) copies, keep the fuller text.
  const pick = (field) => fromInstagram(lead) && !fromInstagram(other)
    ? lead[field] || other[field]
    : longer(lead[field], other[field]);

  return {
    name: pick("name"),
    date: lead.date || other.date,
    time: lead.time || other.time,
    venue: lead.venue || other.venue,
    town: lead.town || other.town,
    description: pick("description"),
    url: lead.url || other.url,
    category: lead.category || other.category,
    sources,
    sourceUrls,
  };
}

function longer(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a.length >= b.length ? a : b;
}
