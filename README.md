# Catskills Events

For local event extraction, set `OPENAI_API_KEY` or put the key by itself in the
ignored `openai_key` file. Environment configuration remains the production path.

## Jev event categorization

Set `TYPESAFE_API_KEY` in your local `.env`, or put the key by itself in the ignored
`jev-key` file, to enable Jev when running `node run.mjs`.
For the scheduled GitHub Actions scrape, add the repository secret `TYPESAFE_API_KEY`.
Credentials are used only by the scraper, never the browser.

Jev assigns the final category for upcoming deduplicated events from all sources,
including cached sources. It uses the existing eight categories and evaluates the
event name, description, venue, and source with a TypeSafe Choice question.
OpenAI extracts event details, reads flyers, and resolves towns; it no longer assigns
categories. Tockify tag mappings and labels in older source caches remain usable as
fallbacks. Fresh extractions default to `other` until Jev categorizes them.

Requests contain up to ten independent event questions. Successful decisions and
their raw confidence/probabilities are cached for seven days in the existing scrape
cache; changed evidence or category instructions invalidate the corresponding entry.
Without a key, or when requests fail or answers are invalid, valid existing labels
remain and uncategorized events use `other`.
Rate limits receive bounded exponential retries; an outage stops further requests
for that run. Logs report new decisions, cache hits, and fallbacks.

No confidence cutoff is assumed to be calibrated. Validate representative real
events (especially mixed activities and sparse descriptions) before treating these
categories as measured improvements over existing labels.

## Instagram polling

Every Instagram source is fetched on every run.

- **Meta Business Discovery** (free) covers business and creator accounts. Set
  `META_PAGE_TOKEN` to a Page access token for a Facebook Page linked to an
  Instagram professional account, with `instagram_basic`,
  `instagram_manage_insights`, `pages_read_engagement` and `pages_show_list`.
  Locally, put it in the ignored `meta_key` file. Page tokens don't expire, but
  Meta revokes data access about 90 days after the last login; the run logs a
  warning two weeks ahead. Renew by generating a token again in Graph API Explorer.
- **Apify `instagram-post-scraper`** (billed per post) covers personal accounts
  Meta can't see, and every account if Meta is down. It requests only posts newer
  than each profile's last fetch, skips pinned posts, and each run is capped at
  $0.25. Set `APIFY_TOKEN` or use the ignored `apifey_key` file.

Fetched posts are stored for 30 days in the scrape cache, and events are only
re-extracted when that set of posts changes. A profile that can't be fetched
keeps its cached events for up to eight days.

Instagram captions with relative dates such as `this Wednesday`, `next Friday`,
`tomorrow`, and `tonight` get a second date pass. Jev reads the named day and week
qualifier from the matching caption; calendar code resolves it from that post's
timestamp in New York time. In event-promotion language, `this Wednesday` means the
upcoming Wednesday on or after the post date; `next Wednesday` means Wednesday in
the following calendar week. Results below 0.60 confidence keep the extracted date.

## Flyer OCR

Google Cloud Vision performs flyer transcription with `TEXT_DETECTION`; OpenAI only
maps that plain OCR text into missing event fields. Set `GOOGLE_VISION_API_KEY` or
put the key by itself in the ignored `gcloud_key` file. In GitHub Actions, add the
repository secret `GOOGLE_VISION_API_KEY`.

Run integration behavior tests without credentials:

```sh
npm test
```

API contract: [TypeSafe HTTP API](https://docs.typesafe.ai/api),
[Choice guidance](https://docs.typesafe.ai/primitives/choice).
