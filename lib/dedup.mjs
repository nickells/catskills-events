import { isAddress, squash, squashPlace } from "./places.mjs";

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

  // Pass 2: fuzzy match — same date + similar name. Events gather into clusters; a newcomer
  // joins the first cluster it matches any member of, and the cluster merges at the end.
  const clusters = [];
  for (const event of byKey.values()) {
    const cluster = clusters.find((members) =>
      members.some((member) => isFuzzyMatch(member, event)) &&
      members.every((member) => timesCompatible(member, event)));
    if (cluster) cluster.push(event);
    else clusters.push([event]);
  }
  return clusters.map(mergeCluster);
}

function normalizeKey(event) {
  const name = normalizeName(event.name);
  const date = event.date || "nodate";
  const venue = squash(event.venue).slice(0, 20);
  return `${date}::${venue}::${name}`;
}

const normalizeName = (name) => squash(name).slice(0, 40);

// Same-named events on one date are the same event only at compatible places. Otherwise a
// generic name merges across the region: one bar's "Trivia Night" took another's town.
function placesCompatible(a, b) {
  if (sameVenue(a, b)) return true;
  const [ta, tb] = [squashPlace(a.town), squashPlace(b.town)];
  const sameTown = ta && ta === tb;
  // Venues written differently in the same town ("Upper Depot Brewing" / "Basilica Hudson")
  // still match when the name is specific enough to be one event.
  return sameTown && Math.min(normalizeName(a.name).length, normalizeName(b.name).length) >= 20;
}

// No conflicting towns, and one venue names the other ("Return Brewing" / "Return Brewing
// Outpost"). With `addressUnknown`, a street address counts as no venue, since it doesn't
// say the venue's name: AllEvents lists Assembly as "236 Wall Street, 3rd Floor, Kingston".
function sameVenue(a, b, { addressUnknown = false } = {}) {
  const [ta, tb] = [squashPlace(a.town), squashPlace(b.town)];
  if (ta && tb && ta !== tb) return false;
  const venue = (event) => (addressUnknown && isAddress(event.venue) ? "" : squashPlace(event.venue));
  const [va, vb] = [venue(a), venue(b)];
  return !va || !vb || va.includes(vb) || vb.includes(va);
}

function isFuzzyMatch(a, b) {
  // Must be on the same date
  if (!a.date || !b.date || a.date !== b.date) return false;
  if (sameNameAndPlace(a, b)) return true;
  // Looser titles ("Next Stop Comedy Night" / "Next Stop Comedy: Giancarlo Biondino") need
  // the times to agree too, and either one Instagram account behind both or one venue. Same
  // town isn't enough: a festival's "Photo Sessions with Santa" down the street stays apart.
  // An address venue is let through only here, where a title has to say enough on its own:
  // two "Open Mic"s in Kingston, one at an address, stay apart.
  if (sameSlot(a, b)) return true;
  if (!timesCompatible(a, b) || !titlesMatch(a, b)) return false;
  return sameInstagramAccount(a, b) || sameVenue(a, b, { addressUnknown: true });
}

// One named venue, one stated start time, and a title word in common: "Friday Music Night" and
// "Music Night with DJ Nick Pardo" at Wayside Cider at 7. The shared word keeps apart what
// really does share a slot: two films at one theater, or "Closed for the Holiday" posted over
// a standing "Locals Night".
function sameSlot(a, b) {
  const [ta, tb] = [normalizeTime(a.time), normalizeTime(b.time)];
  if (!ta || ta !== tb) return false;
  const [va, vb] = [squashPlace(a.venue), squashPlace(b.venue)];
  if (!va || !vb || isAddress(a.venue) || isAddress(b.venue)) return false;
  if (!sameVenue(a, b)) return false;
  const words = new Set(titleWords(a).filter((word) => word.length >= 4));
  return titleWords(b).some((word) => words.has(word));
}

function sameNameAndPlace(a, b) {
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

const normalizeTime = (time) => (time || "").toLowerCase().replace(/:00\b/, "").replace(/[^0-9apm:]/g, "");

// Equal times, or one copy doesn't say.
function timesCompatible(a, b) {
  const [ta, tb] = [normalizeTime(a.time), normalizeTime(b.time)];
  return !ta || !tb || ta === tb;
}

// Words that dress a title up without telling one event from another, joiners written
// either way ("&" / "and", "ft." / "featuring") among them.
const FILLER = new Set([
  "a", "an", "the", "night", "live", "event", "presents",
  "and", "with", "w", "ft", "feat", "featuring",
]);

// A title's distinguishing words: no punctuation, no "- Catskill, NY" or "at <its venue>" tail.
export function titleWords(event) {
  let title = (event.name || "").toLowerCase().replace(/[’'`]/g, "");
  title = title.replace(/\s+[-–—|]\s+[^-–—|]*,\s*(ny|new york)\W*$/, "");
  title = title.replace(/^(an?\s+)?evening\s+(with|of)\s+/, "");
  const at = title.match(/\s(?:at|@)\s+(.*)$/);
  if (at) {
    const tail = squashPlace(at[1]);
    const places = [squashPlace(event.venue), squashPlace(event.town)].filter(Boolean);
    if (tail && places.some((place) => place.includes(tail) || tail.includes(place))) {
      title = title.slice(0, at.index);
    }
  }
  return title.split(/[^a-z0-9]+/).filter((word) => word && !FILLER.has(word));
}

// One title is the other's words, or those words then more ("Next Stop Comedy" and
// "Next Stop Comedy: Giancarlo Biondino"). The shared part must say something on its own.
function titlesMatch(a, b) {
  const [wa, wb] = [titleWords(a), titleWords(b)];
  const [shorter, longer] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (shorter.join("").length < 8) return false;
  return shorter.every((word, i) => longer[i] === word);
}

const instagramAccounts = (event) => sourcesOf(event).filter((source) => source.startsWith("Instagram @"));

// One account posting the same title for one date is one event, wherever the extraction put it.
function sameInstagramAccount(a, b) {
  const accounts = new Set(instagramAccounts(a));
  return instagramAccounts(b).some((account) => accounts.has(account));
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

  // Fields earlier stages added (locate's _state and _landmark, an address) carry over.
  const { source, sourceUrl, ...rest } = { ...other, ...lead };
  return {
    ...rest,
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

// Merge a cluster's copies, then settle the fields a pairwise merge can't: the town most
// copies agree on, the most specific venue there, and the most informative title.
function mergeCluster(members) {
  const merged = members.reduce(mergePair);
  if (members.length === 1) return merged;

  const counts = new Map();
  for (const member of members) {
    const town = squashPlace(member.town);
    if (town) counts.set(town, (counts.get(town) || 0) + 1);
  }
  const top = Math.max(0, ...counts.values());
  const leadTown = squashPlace(merged.town);
  const town = counts.get(leadTown) === top ? leadTown : [...counts.keys()].find((t) => counts.get(t) === top);
  const atTown = members.filter((member) => !town || !member.town || squashPlace(member.town) === town);
  if (town && town !== leadTown) {
    // The town comes with what locate found alongside it.
    const { town: named, _state, _landmark } = atTown.find((member) => squashPlace(member.town) === town);
    Object.assign(merged, { town: named, _state, _landmark });
  }

  // A venue that only names a town ("Livingston Manor") or starts with a street address
  // ("37 Main St, Narrowsburg") says less than a named one.
  const towns = new Set(members.map((member) => squashPlace(member.town)).filter(Boolean));
  const specific = (venue) => venue && !towns.has(squashPlace(venue)) && !isAddress(venue);
  const venues = atTown.map((member) => member.venue).filter(Boolean);
  if (!venues.includes(merged.venue) || !specific(merged.venue)) {
    merged.venue = venues.filter(specific).reduce(longer, null) || venues[0] || merged.venue;
  }

  // Words after "at" name the venue, which the venue field already says.
  const telling = (event) => {
    const words = titleWords(event);
    const at = words.indexOf("at");
    return at > 0 ? words.slice(0, at) : words;
  };
  for (const member of members) {
    const [have, other] = [telling(merged), telling(member)];
    if (other.length > have.length && have.every((word, i) => other[i] === word)) merged.name = member.name;
  }
  return merged;
}

function longer(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a.length >= b.length ? a : b;
}
