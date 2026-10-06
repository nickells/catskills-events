// Places tagged in Instagram posts. Town and tourism accounts post about other venues and
// tag them ("Women's Self-Defense course starts in two weeks! @crcinarkville") without naming
// a town, so the event fell back to the posting account's town (Margaretville). Knowing
// where a tagged account is lets extraction place the event at the tagged venue.

const DAY_MS = 24 * 60 * 60 * 1000;
const PLACE_TTL_MS = 90 * DAY_MS;
const MENTIONS_TTL_MS = 45 * DAY_MS;
const mentionsKey = (post) => `instagram-mentions:${post.id || post.url}`;
const placeKey = (handle) => `instagram-place:${handle}`;

// Usernames each post mentions. Meta strips the "@" from captions, so a model picks them out;
// results are cached per post.
export async function mentionsForPosts(posts, { extractMentions, cache, now = Date.now() }) {
  const result = new Map();
  const fresh = [];
  for (const post of posts) {
    const hit = cache[mentionsKey(post)];
    if (hit && now - hit.ts < MENTIONS_TTL_MS) result.set(post, hit.events);
    else if (post.caption) fresh.push(post);
    else result.set(post, []);
  }
  if (fresh.length) {
    const found = await extractMentions(fresh.map((post) => post.caption));
    fresh.forEach((post, i) => {
      const handles = [...new Set((found[i] || []).map((h) => h.replace(/^@/, "").replace(/\.+$/, "").toLowerCase()).filter(Boolean))];
      cache[mentionsKey(post)] = { ts: now, events: handles };
      result.set(post, handles);
    });
  }
  return result;
}

// Where each tagged account is, from its Instagram name and bio. New lookups are capped per
// run by `budget` (shared across accounts) to stay inside Meta's rate limit; the rest are
// looked up on later runs. Accounts that aren't a single place (bands, people, guides) map to null.
export async function resolveTaggedPlaces(handles, {
  known = {}, lookupProfile, askPlaces, cache, now = Date.now(), budget = { remaining: Infinity }, log = () => {},
}) {
  const places = new Map();
  const toAsk = [];
  for (const handle of handles) {
    const hit = cache[placeKey(handle)];
    if (hit && now - hit.ts < PLACE_TTL_MS) {
      if (hit.events) places.set(handle, hit.events);
      continue;
    }
    if (!lookupProfile || budget.remaining <= 0) continue;
    budget.remaining--;
    try {
      const profile = await lookupProfile(handle);
      toAsk.push({ handle, name: profile?.name || "", bio: profile?.biography || "", knownTown: known[handle] || null });
    } catch (err) {
      log(`    ✗ @${handle}: ${err.message.slice(0, 80)}`);
    }
  }
  if (toAsk.length) {
    try {
      const answers = await askPlaces(toAsk);
      toAsk.forEach((account, i) => {
        const a = answers[i];
        const place = a?.isPlace && a.town ? { name: a.venue || account.name || account.handle, town: a.town, state: a.state || "NY" } : null;
        cache[placeKey(account.handle)] = { ts: now, events: place };
        if (place) places.set(account.handle, place);
      });
    } catch (err) {
      log(`    ✗ Tagged place lookup failed: ${err.message.slice(0, 80)}`);
    }
  }
  return places;
}

// Lines for the extraction prompt: "@crcinarkville = Catskill Recreation Center, Arkville, NY".
export function taggedPlaceLines(handles, places) {
  return handles.filter((h) => places.has(h)).map((h) => {
    const p = places.get(h);
    return `@${h} = ${p.name}, ${p.town}, ${p.state}`;
  });
}
