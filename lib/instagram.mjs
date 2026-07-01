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
  // Start the run without waiting — returns immediately
  const run = await client.actor(PROFILE_SCRAPER_ACTOR).start({
    usernames: sources.map((s) => s.handle),
    resultsLimit: 12,
  });
  console.log(`  Apify run started (${run.id})`);

  return { client, runId: run.id, sources };
}

export async function collectInstagramResults({ client, runId, sources }) {
  // Wait for the run to finish
  console.log(`\n[Instagram] Waiting for Apify run ${runId}...`);
  await client.run(runId).waitForFinish();

  const runInfo = await client.run(runId).get();
  const { items } = await client.dataset(runInfo.defaultDatasetId).listItems();
  console.log(`  ✓ ${items.length} profiles returned`);

  const byHandle = {};
  for (const item of items) {
    byHandle[item.username] = {
      posts: item.latestPosts || [],
      postsCount: item.postsCount || 0,
    };
  }

  // Only keep posts from the last 30 days
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

  return sources.map((source) => {
    const data = byHandle[source.handle] || { posts: [], postsCount: 0 };
    const recent = data.posts.filter((p) => {
      if (!p.timestamp) return true;
      return new Date(p.timestamp).getTime() > cutoff;
    });
    console.log(`    @${source.handle} — ${recent.length} posts (${data.posts.length - recent.length} old skipped)`);
    return { ...source, posts: recent, postsCount: data.postsCount };
  });
}

export function formatPostsForLLM(posts) {
  return posts
    .map((p, i) => {
      const parts = [`--- Post ${i + 1} ---`];
      if (p.url) parts.push(`Post URL: ${p.url}`);
      if (p.timestamp) parts.push(`Posted: ${new Date(p.timestamp).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`);
      if (p.caption) parts.push(p.caption);
      if (p.alt && p.alt.length > 30) parts.push(`[Image: ${p.alt}]`);
      if (p.locationName) parts.push(`Location: ${p.locationName}`);
      return parts.join("\n");
    })
    .join("\n\n");
}
