import { ApifyClient } from "apify-client";

const PROFILE_SCRAPER_ACTOR = "apify/instagram-profile-scraper";

export async function scrapeInstagramProfiles(sources) {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    console.log("  ✗ APIFY_TOKEN not set, skipping Instagram");
    return [];
  }

  const client = new ApifyClient({ token });
  const urls = sources.map((s) => `https://www.instagram.com/${s.handle}/`);

  console.log(`  Calling Apify for ${sources.length} profiles...`);
  const run = await client.actor(PROFILE_SCRAPER_ACTOR).call({
    usernames: sources.map((s) => s.handle),
    resultsLimit: 12,
  });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  console.log(`  ✓ ${items.length} profiles returned`);

  // Each item is a profile with latestPosts nested inside
  const byHandle = {};
  for (const item of items) {
    byHandle[item.username] = item.latestPosts || [];
  }

  return sources.map((source) => {
    const posts = byHandle[source.handle] || [];
    console.log(`    @${source.handle} — ${posts.length} posts`);
    return { ...source, posts };
  });
}

export function formatPostsForLLM(posts) {
  return posts
    .map((p, i) => {
      const parts = [`--- Post ${i + 1} ---`];
      if (p.caption) parts.push(p.caption);
      if (p.alt && p.alt.length > 30) parts.push(`[Image: ${p.alt}]`);
      if (p.locationName) parts.push(`Location: ${p.locationName}`);
      return parts.join("\n");
    })
    .join("\n\n");
}
