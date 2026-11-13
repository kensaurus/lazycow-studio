# Connected services, now and later

Every outside service the studio talks to, why it uses it, and what is worth adding. The evidence, with sources and dates, is in the maintainer's dated research notes (`docs/research/`, kept out of the public copy), integrations, docs and pain points (10 Nov).

## Connected now

| Service | For | How | Where the secret lives |
|:--|:--|:--|:--|
| YouTube Data API v3 | Upload and schedule Shorts; upload long videos (private, unlisted, public or scheduled); read views. Several channels per project: `main` for Shorts, `a2`, `a3`, ... for more. Uploads have their own allowance since 1 June 2026: 100 a day per Google app; the swap uses at most 20 ([getting started](https://developers.google.com/youtube/v3/getting-started)). | The owner's own Google app (OAuth, PKCE, loopback). One app can be shared with every project. | `%STUDIO_DATA%\secrets\youtube_token.bin` and `youtube_token-a<N>.bin` (DPAPI on Windows); a shared app in `%STUDIO_HOME%\youtube_client.json` |
| Meta Graph API | Schedule Facebook Page Reels up to 29 days ahead; read views | The owner's own Meta app; the Page token has no expiry date | `%STUDIO_DATA%\secrets` |
| Bluesky (atproto) | Video posts. The studio sends each at its time. | "Sign in with Bluesky" (OAuth, about 2 weeks) or an app password | `%STUDIO_DATA%\secrets` |
| The owner's Chrome (Playwright extension) | Book X, TikTok, Google Maps, LINE and LinkedIn in each site's own scheduler | `server/helper.mjs`, [helper.md](helper.md) | `PLAYWRIGHT_MCP_EXTENSION_TOKEN` in `.env` |
| Google Photos Picker API | Import picked photos and videos | OAuth, read-only scope | `%STUDIO_DATA%\secrets` |
| Firecrawl | Posting › Research: web research, read-only | API key | `FIRECRAWL_API_KEY` in `.env` |
| OpenRouter | The AI reviewer (also the judge of a new version), Research angles, Words suggestions (the owner approves each), long-video chapter names | API key, inside the daily budget | `.env` |
| fal.ai, Together AI | Paid AI tools on a reel (slow motion, sharpen, music, voice); the music bed of a long video | API key, priced first, inside the limits | `.env` |
| Openverse | CC0 and public-domain music | No key, 200 searches a day | — |

## Why Chrome, not the networks' APIs

Only the networks' own schedulers book ahead and still post while this PC is off.

| Network | API status, November 2026 | Decision |
|:--|:--|:--|
| TikTok | Audited apps only. Unaudited apps post privately, and a tool for your own accounts is rejected. No publish-time field. | Keep Chrome. |
| X | Pay per use: about $0.015 a post, $0.20 with a link. No scheduling found. | Keep Chrome. The API is a possible fallback for "post now". |
| Google Business Profile | Posts take photos only (no video). The Q&A API closed on 3 Nov 2025. Reviews API is active. | Keep Chrome for posts. Use the API later for reviews. |
| LINE | The Messaging API sends now and cannot schedule. LINE 投稿 (which replaced VOOM) has no API. | Keep Chrome. Retarget `line-voom` to 投稿 when the account has it. |
| LinkedIn | The Community Management API is hard to get and accepts only "published now" posts. | Keep Chrome. |
| Threads | The API works for the owner as a tester on their own app, but cannot schedule. | Possible way to un-pause Threads (ROADMAP item). |
| Instagram | API exists | Off on purpose: another person posts it. |
| Xiaohongshu | No public posting API | Stay manual. |

## Worth adding later

| Integration | Value | Plan |
|:--|:--|:--|
| Tracking links (`utm_campaign=<reel>`) | High: count bookings per reel, not just views | ROADMAP 6 |
| One outbound webhook | Medium: plug in Zapier, n8n, Make or a phone push | ROADMAP 13 |
| Google reviews | High: answer reviews quickly, with replies approved by the owner | ROADMAP 15 |
| OpenTimelineIO export | Medium: fine-tune a reel in Premiere 25.6+ or DaVinci Resolve 18.5+ | ROADMAP 14 |
| iCloud, Drive or Dropbox folders | High and nearly free: the folder watcher already catalogues any folder | A how-to in the user guide |
| A calendar feed of bookings | Medium-low | Later |

**Not worth building:** Klook, Rakuten, Jalan or Airbnb APIs (they are booking inventory, not publishing), Canva and CapCut (no useful API; export MP4 and SRT instead).

## Not applicable to a local tool

The studio runs only on 127.0.0.1, so search engines never see it, and a sitemap, SEO or AEO for the studio itself does nothing. Those belong to a public docs site, when the engine is released. The integrations research (section 3) covers docs-as-code, OpenAPI, Mermaid and llms.txt; Ahrefs found most llms.txt files are never read.
