# Performance API (`/api/perf*`)

How each reel did on each network, what worked, and what to try next. Served by `server/review.mjs`; every call
runs `python -m studio.perf <action>` (`py/studio/perf.py`, learning in `py/studio/learn.py`). Research behind
the choices: [`research/2026-11-09-reel-learning.md`](research/2026-11-09-reel-learning.md).

Rules:

- **Nothing here posts.** Suggestions only steer how drafts are made. A person still approves every reel.
- **No tokens on the wire.** Errors are scrubbed and tokens are never returned.
- **Same-origin only.** POSTs must come from the studio's own origin, like every studio endpoint.
- **Errors** are `{ "error": "<one plain sentence>", "code": "<code>" }` with a 4xx or 5xx status. The codes are:
  - `bad_input` (400)
  - `not_found` (404)
  - `too_big` (413)
  - `timeout` (504)
  - `bug` (500)

## How numbers arrive

| Network | How | What comes back |
|---|---|---|
| YouTube | API, hourly | views, likes and comments. With the Analytics scope, from 48 h on: watch time, average % viewed, average seconds viewed, shares, subscribers gained, and engaged views (in `extra`). |
| Facebook | API, hourly | plays (`blue_reels_play_count`, no replays), reach, average seconds watched, total watch time, follows, comments, shares and likes. Replays and total plays are in `extra`. Needs `read_insights`. |
| Bluesky | public API, hourly | likes, replies (in `comments`), reposts + quotes (in `shares`) and bookmarks (in `saves`). There are no views. |
| TikTok, X, Pinterest, Google Maps, LinkedIn | the browser helper in your Chrome (`POST /api/perf/collect-browser`, and hourly while it is connected) | what each post's own page shows: X views, likes, replies, reposts, bookmarks; the others whatever their pages' own data holds. |
| TikTok, X, Pinterest, Google Maps, LINE, LinkedIn, Threads, Instagram | `POST /api/perf/manual` or `POST /api/perf/import` | whatever you type or the export has. |

**Checkpoints.** A post is read once at each checkpoint: `1h`, `24h`, `72h`, `7d` and `28d` after it went out. The
reading is labelled with the newest checkpoint the post has reached, and readings are kept, never overwritten. After 30
days a post is final.

**Timer.** The server timer runs `collect` 5 minutes after start, then hourly. Python keeps the time of the last run,
so a restart never reads twice.

**Live posts.** "Live" means `status` is `posted`, or `scheduled` with a time that has passed.

**Measured posts.** A post counts as measured once it has a reading at least 20 h old. The learner uses the reading
nearest 72 h. Each post is compared with its own network's median over that network's newest 30 measured posts. The
number compared is:

- YouTube: engaged views when most readings have them, else views.
- Other networks: views, else reach (impressions), else likes + comments + shares + saves.

**Steering threshold.** Until **15 measured posts** exist, suggestions only explore and learned steering stays off.

## Common shapes

`Numbers`: every field is optional and is `null` when the network or file did not report it.

```json
{ "views": 253, "likes": 2, "comments": 0, "shares": 7, "saves": 1,
  "watch_time_s": 7230.0, "avg_view_pct": 61.3, "avg_view_s": 9.1, "completion_pct": 21.5,
  "followers_gained": 2, "reach": 900 }
```

`Reading`: one stored row.

```json
{ "id": 2, "post_id": 1, "network": "youtube", "slug": "loud-1107", "remote_id": "jKq4gp5a7S0",
  "fetched_at": "2026-11-09T09:04:02+08:00", "age_h": 14.07, "checkpoint": "1h",
  "...Numbers": "...", "extra": { "engaged_views": 400 }, "source": "api" }
```

`source` is `api`, `manual`, `csv` or `browser` (read off the network's own page in your Chrome by the helper).

`Effect`: one choice in plain words.

```json
{ "feature": "look", "level": "punch", "label": "punch look", "mult": 1.61, "low": 1.24, "high": 2.09,
  "posts": 10, "pBetter": 0.952, "verdict": "fairly sure it helps",
  "sentence": "punch look: about 1.6x the median views on TikTok (10 posts; fairly sure it helps)" }
```

- `mult`: posts with this choice against their network's median.
- `low` and `high`: an 80 % interval around `mult`.
- `pBetter`: the chance this choice beats the feature's *other* choices, not the median.
- `verdict` is one of:
  - `N post: too few to tell`
  - `fairly sure it helps` (pBetter ≥ 0.9)
  - `probably helps; still uncertain` (≥ 0.75)
  - `still uncertain`
  - `probably holds back; still uncertain` (≤ 0.25)
  - `fairly sure it holds back` (≤ 0.1)
  - `every measured post had it: nothing to compare yet`

**Features and their levels:**

| Feature | Levels |
|---|---|
| `theme` | the theme key |
| `style` | `column` `centre` `lower` `split` |
| `look` | `film` `punch` `split` `ember` `plain` |
| `recipe` | `countdown` `timeline` `pov` `altitude` `none` |
| `loop` | `loop` `no loop` |
| `length` | `under 12 s` `12-16 s` `16-22 s` `22-35 s` `35-60 s` `over 60 s` |
| `clips` | `1-6` `7-9` `10-12` `13+` |
| `music` | `auto` `picked` `AI bed` `none` |
| `sfx` | `effects` `no effects` |
| `hook` | the hook line, in Japanese |
| `cut` | `short` `long` |
| `weekday` | `Monday` … `Sunday` (JST) |
| `hour` | `00-05` `06-09` `10-13` `14-17` `18-20` `21-23` (JST) |

## `GET /api/perf?slug=<slug>`

One reel: its features and every post of it, with readings.

```json
{ "slug": "loud-1107",
  "features": { "theme": "loud", "style": "centre", "look": "plain", "recipe": "none", "loop": "no loop",
                "length": "12-16 s", "clips": "7-9", "music": "auto", "sfx": "effects",
                "hook": "遠いからこそ、騒げる。", "cut": "short", "seconds": 15.0,
                "weekday": "unknown", "hour": "unknown" },
  "posts": [
    { "post_id": 1, "network": "youtube", "status": "scheduled", "at": "2026-11-08T19:00",
      "url": "https://youtube.com/shorts/jKq4gp5a7S0", "live": true, "age_h": 14.1,
      "latest": { "fetched_at": "...", "checkpoint": "1h", "source": "api", "...Numbers": "..." },
      "readings": [ "Reading", "..." ],
      "vsMedian": null,
      "canCollect": true } ] }
```

- `latest` is `null` before the first reading.
- `vsMedian` is `null` until the post is measured (at least 20 h). Then it is
  `{ "metric": "views", "value": 812, "median": 300, "ratio": 2.7, "sentence": "2.7x the median views on YouTube (3 measured posts there)" }`.
- `canCollect` is false for networks that need numbers by hand or a CSV: show the entry form for those.
- Reel-level `weekday` and `hour` are `unknown`, because the time belongs to each post.

## `GET /api/perf/summary[?network=<net>]`

What worked and what did not. Leave out `network` to pool all networks; with it, the effects are that network's own.

```json
{ "ready": false, "measured": 4, "needed": 15, "tooNew": 2, "network": null,
  "networks": { "youtube": { "name": "YouTube", "metric": "views", "median": 300, "posts": 4 } },
  "headline": "Not enough data yet: 4 of 15 measured posts. Read these as early hints, not findings.",
  "worked": [ "Effect", "..." ],
  "didnt":  [ "Effect", "..." ],
  "features": { "look": [ "Effect", "..." ], "recipe": [ "..." ] },
  "sentences": [ "<headline>", "<worked sentences>", "<didn't sentences>" ],
  "method": "Each post's reading nearest 72 h old is compared with its network's median ..." }
```

- `worked` holds up to 6 effects with pBetter ≥ 0.75 and at least 2 posts. `didnt` holds up to 6 with pBetter ≤ 0.25.
- Each list in `features` is sorted by `mult`, highest first.
- `sentences` is ready to show as-is.
- With no measured posts, `headline` says so and `worked`, `didnt` and `features` are empty.

## `GET /api/perf/suggest[?network=&n=3&explore=0.3&seed=]`

Next-reel suggestions.

| Parameter | Default | Range |
|---|---|---|
| `n` | 3 | 1–10 |
| `explore` | 0.3 | 0–1, the share of suggestions that explore |
| `seed` | random | an integer; the same seed gives the same answer |

```json
{ "ready": false, "measured": 4, "needed": 15, "explore": 0.3, "network": null, "metric": "views",
  "suggestions": [
    { "mode": "explore", "look": "ember", "recipe": "pov", "style": "split", "length": "16-22 s", "hour": "18-20",
      "why": { "look": "exploring: ember look has 0 measured posts so far", "...": "..." } },
    { "mode": "learned", "look": "punch", "recipe": "countdown", "style": "centre", "length": "12-16 s", "hour": "18-20",
      "why": { "look": "punch look: about 1.6x the median views (all networks) (10 posts; fairly sure it helps)", "...": "..." } } ],
  "distribution": { "look": { "punch": 0.71, "film": 0.12, "...": "..." }, "recipe": { "...": "..." },
                    "style": { "...": "..." }, "length": { "...": "..." }, "hour": { "...": "..." } },
  "note": "Exploring only: 4 of 15 measured posts so far. ... The house posting time is 19:00 JST; move it only if another hour keeps winning." }
```

`mode` is one of two:

- `explore`: the least-tried choice for each feature (ties are broken at random).
- `learned`: one draw from the posterior, taking the best choice under it (Thompson sampling).

Below `needed`, every suggestion explores.

`distribution` gives, for each feature, how often each choice is the best over 400 posterior draws. It is a good
"what the model believes" bar chart.

Suggestions use only the choices the maker makes: lengths `under 12 s` to `22-35 s` (the 40-60 s explainer is its
own cut) and hours `06-09` to `21-23` JST.

## `POST /api/perf/collect`

Body: `{ "fresh": false, "post_ids": [1, 12] }`. Both fields are optional.

- `fresh` also re-reads posts whose last reading is more than 15 minutes old.
- `post_ids` limits the run to those posts.

```json
{ "ran": true, "at": "2026-11-09T09:04:02+08:00", "read": 2,
  "stored": [ { "post_id": 1, "slug": "loud-1107", "network": "youtube", "checkpoint": "1h", "age_h": 14.07,
                "views": 253, "likes": 2, "comments": 0 } ],
  "skipped": [ { "post_id": 12, "slug": "aerial360-1108", "network": "bluesky", "why": "already read for this checkpoint" } ],
  "problems": [ { "network": "facebook", "error": "Facebook: the token may not read insights. ...", "code": "permission" } ],
  "notes": [ "YouTube: views, likes and comments only. For watch time ... press Connect YouTube again ..." ],
  "needsNumbers": [ { "post_id": 18, "slug": "aerial360-1108", "network": "pinterest", "age_h": 1.17,
                      "checkpoint": "1h", "url": "https://www.pinterest.com/pin/..." } ],
  "notOutYet": [ { "post_id": 2, "slug": "autumn-1108-2", "network": "youtube", "at": "2026-11-09T19:00" } ],
  "summary": "Read 2 posts; 1 post on other networks needs numbers by hand or a CSV." }
```

- A network that fails goes in `problems` and the others still run.
- `needsNumbers` is the to-do list for manual entry or CSV import.
- The hourly timer sends `{ "timer": true }`. That call returns `{ "ran": false, "why": "checked less than an hour ago", "lastRun": "..." }`
  inside the gap. The page never needs to send it.

Quota per run:

- YouTube: 1 unit per 50 Shorts (Data API), plus 1 Analytics query per Short at 48 h or older.
- Facebook: 1 call per reel.
- Bluesky: 1 call per 25 posts, plus 1 handle lookup per post that has no `remote_id`.

## `POST /api/perf/manual`

```json
{ "post_id": 30, "views": 1500, "likes": 80, "comments": 3, "shares": 4, "saves": 9,
  "avg_view_s": 8.5, "completion_pct": 18.5, "followers_gained": 3,
  "at": "2026-11-12T19:30", "note": "from the TikTok app" }
```

- `post_id` and at least one number are required. Any field of `Numbers` is accepted.
- `at` is when the numbers were read. The default is now, and it may not be in the future.
- Percentages are 0–100; every other number is 0 or more.

Reply: `{ "stored": Reading, "post": { "id", "slug", "network", "at", "url" } }`.

The browser helper stores through the same code with `"source": "browser"`, plus `"page"` (the https address it read) and
`"remote_id"` (the post's id on the network). The page's own form never sends these, so typed numbers stay `manual`.

## `POST /api/perf/collect-browser`

Reads the numbers of every live TikTok, X, Pinterest, Google Maps and LinkedIn post whose current checkpoint has no
reading yet, off each network's own pages in **your Chrome** (the browser helper, [helper.md](helper.md)). **Read only:**
it opens pages, reads them and closes its tabs. It never posts, likes or follows.

Body: `{ "networks": ["x", "tiktok"] }`. The field is optional; leave it out for all five.

Reply: the queued job (one helper job runs at a time; the same request while it runs returns that job).

```json
{ "slug": "helper-perf", "kind": "helper", "status": "queued", "label": "waiting for the helper", "pct": 0, "...": "job view" }
```

Progress comes over `/api/events` (`job`) and `GET /api/job?slug=helper-perf`. When it ends, `job.result` is:

```json
{ "stored": [ { "post_id": 13, "network": "x", "slug": "aerial360-1108", "checkpoint": "24h",
                "views": 456, "likes": 10, "comments": 3, "shares": 2, "saves": 1 } ],
  "left": [ { "post_id": 18, "network": "pinterest", "slug": "aerial360-1108", "state": "missing",
              "message": "Pinterest: the post was not found on its page." } ],
  "summary": "Read 1 of 2 posts in your Chrome; 1 not read (see the list)." }
```

- `left[].state` is one of:
  - `missing`: not found, or no counts shown yet;
  - `signin`: Chrome is signed out of that site;
  - `failed`: the page broke, with the reason.
- A post read for the first time also gets its own link in the posting log (X status, pin, video), so the next read goes straight to it.
- The hourly timer starts this job too, but only while the helper is already connected to your Chrome. It never opens a
  connect page or asks for a click.
- `400 bad_input` when `networks` names none of the five.

Python's read-only list behind it: `python -m studio.perf needs` (`{networks?}` → `{needsNumbers}`, the same rows
`collect` lists, without reading any network or moving the hourly timer).

## `POST /api/perf/import`

```json
{ "network": "x", "csv": "<the exported file's text>", "mapping": { "My column": "views" }, "post_id": 7, "dry_run": true }
```

| Field | Required | Notes |
|---|---|---|
| `network` | yes | the network the export is from |
| `csv` | yes | at most 2 MB; comma, tab or semicolon separated; a title line above the header is skipped |
| `mapping` | no | `{column: field}`, overrides the automatic match. Fields are the `Numbers` keys plus `_link`, `_id`, `_time`, `_title` and `_reposts` (added to shares) |
| `post_id` | no | puts every row on that post (a single-video export) |
| `dry_run` | no | returns what would be stored without storing it |

**Column matching.** Headers are matched case-insensitively, without punctuation or brackets.

Confirmed names:

- X post export: `Post id`, `Date`, `Post text`, `Post Link`, `Impressions`→reach, `Likes`, `Bookmarks`→saves,
  `Shares` + `Reposts`→shares, `Replies`→comments, `New follows`. `Engagements` is ignored.
- Legacy X: `Tweet id`, `Tweet permalink`, `Tweet text`, `time`, `impressions`, `retweets`, `replies`, `likes`, `follows`.
- TikTok Studio: `Video title` / `Video name`, `Post time` / `Date`, `Video views` / `Total views`, `Likes`,
  `Comments`, `Shares`, `Add to Favorites`→saves, `Average watch time`, `Total play time`, `Watched full video`, `New followers`.

Japanese names (`再生数`, `いいね数`, `コメント数`, `シェア数`, `保存数`, `インプレッション数`, `投稿日時`, …) are
guesses. Check them on a real localised export and send a `mapping` if one is missed.

**Values.** Numbers like `1,234`, `1.2K`, `3.4M`, `1.5万` and `21.5%` are read. Times like `0:12`, `1:02:03`, `8.5s`
and `2h 30m` become seconds. A date or time without a zone is taken as JST.

**Matching rows to posts**, in this order:

1. The row's link or id matches the post's link or `remote_id`.
2. A date without a time (overview or daily files): the one post that went out that day in JST, using the title as a
   tie-break.
3. The post time within 12 h.
4. The title matches the reel's title or caption lines.

**Duplicates.** A row already imported with the same numbers is skipped (`duplicates`).

```json
{ "network": "x", "dryRun": false, "rows": 2,
  "columns": { "reach": "Impressions", "likes": "Likes", "_reposts": "Reposts", "_time": "Date", "...": "..." },
  "stored": [ { "row": 1, "post_id": 7, "slug": "autumn-1108-2", "matchedBy": "date", "checkpoint": "24h",
                "reach": 1234, "likes": 20, "shares": 7 } ],
  "unmatched": [ { "row": 2, "title": "something else", "time": "Sat, Nov 15, 2026", "link": "https://x.com/...",
                   "why": "no post on this network that day" } ],
  "duplicates": 0,
  "summary": "Stored 1 of 2 rows for x; 1 did not match a post (send post_id, or add the post's link with Mark posted)." }
```

## `GET /api/perf/status`

```json
{ "collectors": { "youtube": { "name": "YouTube", "ready": true, "why": null, "analytics": false },
                  "facebook": { "name": "Facebook", "ready": true, "why": null },
                  "bluesky": { "name": "Bluesky", "ready": true, "why": null } },
  "lastRun": "2026-11-09T09:04:12+08:00", "readings": 2,
  "checkpoints": ["1h", "24h", "72h", "7d", "28d"], "csvFields": ["views", "likes", "..."] }
```

When `analytics` is false, show "Press Connect YouTube again and allow *View YouTube Analytics reports*".

## Steering "Vary the look" (opt-in)

There are two ways to switch it on:

- `POST /api/autopilot` with `"vary": true, "learned": true`, for one run.
- `STUDIO_PERF_STEER=1` in `.env`, for every autopilot run.

Below 15 measured posts nothing changes. Above it, `service.vary_look` first makes its usual random choice. Then on 70 %
of reels (the other 30 % explore) it replaces the text layout and picture look with one Thompson draw from
`learn.vary_draw`. Firelight (`ember`) still stays for night and fire themes. Without the flag, the random draw is
exactly what it was.

## MCP

`perf_summary {network?}` and `perf_suggest {network?, n?, explore?, seed?}` are read-only tools in `server/mcp.mjs`.
They call `GET /api/perf/summary` and `GET /api/perf/suggest`.
