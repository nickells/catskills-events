// A source's events from the cache, or read fresh, tagged with the source and cached.
export async function cachedEvents(cache, key, { name, sourceUrl, read, ttl }) {
  const cached = cache.get(key, ttl);
  if (cached) {
    console.log(`\n[${name}] ✓ ${cached.length} events (cached)`);
    return cached;
  }
  const events = (await read()).map((e) => ({ ...e, source: name, sourceUrl }));
  console.log(`  ✓ ${events.length} events`);
  cache.set(key, events);
  return events;
}
