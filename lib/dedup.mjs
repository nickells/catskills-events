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

function isFuzzyMatch(a, b) {
  // Must be on the same date
  if (!a.date || !b.date || a.date !== b.date) return false;

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

function mergePair(a, b) {
  const sources = [
    ...new Set([
      ...(a.sources || (a.source ? [a.source] : [])),
      ...(b.sources || (b.source ? [b.source] : [])),
    ]),
  ];

  // Collect all sourceUrls keyed by source name
  const sourceUrls = { ...(a.sourceUrls || {}), ...(b.sourceUrls || {}) };
  if (a.source && a.sourceUrl) sourceUrls[a.source] = a.sourceUrl;
  if (b.source && b.sourceUrl) sourceUrls[b.source] = b.sourceUrl;

  return {
    name: longer(a.name, b.name),
    date: a.date || b.date,
    time: a.time || b.time,
    venue: a.venue || b.venue,
    town: a.town || b.town,
    description: longer(a.description, b.description),
    url: a.url || b.url,
    category: a.category || b.category,
    sources,
    sourceUrls,
  };
}

function longer(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a.length >= b.length ? a : b;
}
