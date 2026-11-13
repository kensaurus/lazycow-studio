# Research API (Firecrawl): request and response shapes

For the Research page. Server: `server/review.mjs`; logic: `py/studio/research.py`; tests: `py/tests/test_research.py`,
`test/mcp.test.mjs`. Sources and costs: `docs/research/2026-11-09-firecrawl.md`.

Everything here is **read-only**: results are suggestions for a person, never post copy, and nothing is posted.
Every successful answer has `summary` (one plain sentence to show first) and `sources` (the URLs it came from).

## How calls run

- **Synchronous, with a timeout.** Each request runs `python -m studio.research <action>` as its own short process
  (not the footage helper, so library searches stay fast) and the HTTP response waits for it. Typical times seen
  2026-11-09: links 2 s, events 5 s, ideas 9 s, page 30 s, site check 45 s (11 s when cached). Server timeouts:
  ideas / page / events 120 s, site-check / links 150 s, status 30 s. Show a spinner; do not poll.
- The same request sent twice while the first still runs shares one run (a double click costs nothing extra).
- **Cache:** every Firecrawl answer is kept 24 h on disk (`STUDIO_HOME/research/cache`, default `~/.lazycow`), keyed by
  the exact Firecrawl request. A repeat is free and comes back with `cached: true`. The comparisons (facts, links,
  dates) are recomputed every time, so a fixed fact shows at once. Send `fresh: true` to skip the cache (costs credits).
- **Daily cap:** at most `STUDIO_RESEARCH_DAILY_CAP` live Firecrawl requests a day (default 60; the cache does not
  count). Over it: HTTP 429, code `cap`.
- Every POST needs the studio's own `Origin` (same rule as the rest of the API).
- `cost` on every answer: `{firecrawlCalls, fromCache, credits}` for this request (credits are Firecrawl's own count for
  searches, the documented price for scrapes).

## Errors (every endpoint)

HTTP status + `{ "error": "<one plain sentence with the fix>", "code": "<code>" }`. The key never appears in an error.

| code | HTTP | `error` (as sent) |
| --- | --- | --- |
| `no_key` | 400 | Add your Firecrawl key in Settings › Keys & AI. |
| `bad_key` | 400 | Firecrawl did not accept the key. Paste a fresh key from firecrawl.dev/app/api-keys in Settings › Keys & AI. |
| `no_credits` | 402 | Firecrawl is out of credits for this month. Top up at firecrawl.dev/app or wait for the monthly reset; results already cached still work. |
| `rate_limited` | 429 | Firecrawl says too many requests right now. Wait 30 seconds, then try again. (seconds from `Retry-After` when sent) |
| `cap` | 429 | The studio's daily research limit (60 Firecrawl requests) is used up. It resets at midnight; set STUDIO_RESEARCH_DAILY_CAP in .env to change it. Results already cached still work. |
| `blocked` | 422 | That site answered HTTP 403: it blocks automatic reading. Open it in your browser instead: <url> (or: Firecrawl cannot read that site …) |
| `not_found` | 422 | That page was not found (HTTP 404). Check the address: <url> |
| `network` | 503 | Could not reach Firecrawl. Check the internet connection, then try again. |
| `timeout` | 504 | Firecrawl took too long to answer. Try again in a minute. (or the studio's own: Research took longer than 120 seconds and was stopped …) |
| `upstream` | 502 | Firecrawl had a problem on its side. Try again in a few minutes. |
| `bad_input` | 400 | e.g. Paste the page's address, starting with https:// · days: a whole number from 1 to 90. · Firecrawl charges extra for X and LinkedIn pages … |
| `forbidden` | 400 | Firecrawl refused the request (…). Check the key's plan in firecrawl.dev/app. |
| `bug` | 500 | Research stopped on a problem in the studio: <type and place>. |

## GET /api/research — status

`?fresh=1` re-reads the credit balance (otherwise cached 10 min). Free: never uses credits or the daily cap.

```json
{
  "ready": true,
  "summary": "Research is ready. 86,157 Firecrawl credits left.",
  "credits": { "remaining": 86157, "plan": 100000, "used": 13843, "periodEnd": "2026-12-03T00:25:32.000Z" },
  "cache": { "entries": 10, "bytes": 412345, "oldest": "2026-11-09T08:15:24", "ttlHours": 24, "folder": "C:\\Users\\you\\.lazycow\\research\\cache" },
  "today": { "date": "2026-11-09", "requests": 10, "credits": 31 },
  "dailyCap": 60,
  "llm": false,
  "sources": ["https://api.firecrawl.dev/v2/team/credit-usage"]
}
```

- No key: `ready: false`, `credits: null`, `summary: "Add your Firecrawl key in Settings › Keys & AI."` (still HTTP 200).
- Key present but rejected or Firecrawl down: `ready: true`, `credits: null`, plus `creditsError` (the sentence) and
  `creditsCode` (`bad_key`, `network`, …). Show the sentence beside the key field.
- `llm`: true when an OpenRouter key is set, so post angles can come from AI (inside the studio's daily USD budget).

## POST /api/settings — save the Firecrawl key

Request: `{ "firecrawl_key": "fc-…" }`. `""` removes the key. May be combined with `tz` (then the tz flow runs too
and the server restarts as before); with the key alone there is **no restart**.

1. The key is checked with Firecrawl's free credit call. 2. It is upserted into the studio's `.env` as
`FIRECRAWL_API_KEY` (shared by every project; `.env` is git-ignored). 3. It is never echoed back.

```json
{ "ok": true, "research": { "ready": true, "credits": { "remaining": 86313, "plan": 100000, "used": 13687, "periodEnd": "2026-12-03T00:25:32.000Z" } } }
```

Errors: 400 `bad_key` ("That does not look like a Firecrawl key (they start with fc-). Copy it again from
firecrawl.dev/app/api-keys." or the `bad_key` sentence above); `.env` is not touched when the check fails.
The key in `.env` wins over a machine-wide `FIRECRAWL_API_KEY` environment variable (this PC has one, and it is invalid).

## POST /api/research/ideas — ideas and trends

Request (all optional): `{ "topic": "冬キャンプ", "days": 30, "fresh": false }`. `topic` ≤ 120 characters; default
"嬬恋村 キャンプ ワーケーション 群馬" (ja) and "Tsumagoi Gunma camping workation" (en). `days` 1–365 (default 30).
Cost: 2 searches (web + news, 8 each) ≈ 4–8 credits.

```json
{
  "summary": "15 recent pages and articles about camp, workation and Tsumagoi from the last 30 days, 5 post angles.",
  "topic": null,
  "queries": ["嬬恋村 キャンプ ワーケーション 群馬", "Tsumagoi Gunma camping workation"],
  "days": 30,
  "items": [
    { "title": "東京新聞の群馬版（11月6日）で、嬬恋牧場Work&Campを …", "url": "https://www.instagram.com/p/…/", "source": "instagram.com",
      "date": null, "snippet": "…", "kind": "web", "lang": "ja" }
  ],
  "hashtags": [ { "tag": "#ワーケーション", "count": 3 } ],
  "keywords": [ { "word": "標高", "count": 2 } ],
  "angles": [
    { "title": "「camp」 with the field reel", "why": "3 recent pages mention camp. The field reel already shows it with approved words: post it while people are looking.",
      "sources": ["https://…", "https://…"], "from": "template", "guard": [] }
  ],
  "sources": ["https://…"],
  "note": "Suggestions for a person. Words that go into a post come only from the studio's approved copy; nothing here is posted.",
  "cached": false,
  "cost": { "firecrawlCalls": 2, "fromCache": 0, "credits": 4 }
}
```

- `items[].kind`: `web` | `news`; `date` is the news date as Firecrawl writes it ("3 days ago") or `null` for web.
- `keywords` leave out the topic's own words; they need ≥ 2 pages.
- `angles` (3–5): `from` is `ai` (OpenRouter) or `template`. Each cites only URLs from `items`. `guard` lists fact-guard
  hits in the angle's own words (prices, banned phrases): show them as a warning.

## POST /api/research/site-check — the website against our facts

Request (all optional): `{ "url": "https://…", "fresh": false }`. Without `url`: the project's profile-kit link
(`/api/profiles`, query stripped; here `https://tsumagoi.kensaur.us/`) and the booking page our posts link to
(`/reserve`), plus the private-hire page the site links as 貸切 when our charter prices were not found yet (text only).
With `url`: just that page. Cost: 5 credits per main page (Markdown + JSON), 1 for the extra page.

"Our facts" are read from the approved copy: `studio.reels` POSTS / SHORT / REELS, `studio.assemble` THEMES, the
venue and charter lines, `shared/reels.json` and the profile kit.

Below, the first fact is from the real run on 2026-11-09 (all 15 matched); the `mismatch` row is illustrative.

```json
{
  "summary": "Checked 3 pages of tsumagoi.kensaur.us: 15 facts match, 0 differ, 0 to check by eye, 0 not stated on the website.",
  "site": "https://tsumagoi.kensaur.us/",
  "pages": ["https://tsumagoi.kensaur.us/#reasons", "https://tsumagoi.kensaur.us/reserve", "https://tsumagoi.kensaur.us/charter#day"],
  "facts": [
    { "fact": "field_first_yen", "label": "Field only: first adult per night", "ours": 5200, "site": 5200,
      "where": ["the view post", "the field post"], "source": "https://tsumagoi.kensaur.us/#reasons", "onPage": true,
      "status": "match", "message": "Field only: first adult per night: the website and your copy both say ¥5,200." },
    { "fact": "field_extra_yen", "label": "Field only: each extra person", "ours": 2200, "site": 5500, "where": ["the view post", "the field post"],
      "source": "https://…", "onPage": true, "status": "mismatch",
      "message": "Field only: each extra person: the website says ¥5,500; your copy says ¥2,200 (the view post and the field post)." }
  ],
  "inclusions": [ { "item": "parking", "status": "match", "message": "Both say parking." } ],
  "booking": { "site": "https://tsumagoi.kensaur.us/reserve?tab=camping", "ours": "https://tsumagoi.kensaur.us/reserve", "status": "match",
               "message": "Booking link: the website and your posts both use /reserve on tsumagoi.kensaur.us." },
  "mismatches": ["…the `message` of every fact with status mismatch…"],
  "otherPrices": [ { "label": "車中泊 (1台 2名込み)", "yen": 3500 } ],
  "sources": ["https://tsumagoi.kensaur.us/#reasons", "https://tsumagoi.kensaur.us/reserve", "https://tsumagoi.kensaur.us/charter#day"],
  "note": "Numbers count only when the page text writes them …",
  "cached": false,
  "cost": { "firecrawlCalls": 1, "fromCache": 2, "credits": 1 }
}
```

- `facts[].fact`: `altitude_m`, `fibre_mbps`, `groups_per_day`, `event_cap`, `nearest_homes_km`, `field_first_yen`,
  `field_extra_yen`, `camp_first_yen`, `camp_extra_yen`, `charter30_day_yen`, `charter30_tent_yen`, `charter50_day_yen`,
  `charter50_tent_yen`, and the derived `field_two_adults_yen` / `camp_two_adults_yen` (the site's 2-adult price against
  our first + extra person).
- `facts[].status`:
  - `match`: the page text writes our number (with its unit; a price near its plan's name).
  - `mismatch`: our number is not on the page, and a different number is written right beside this plan's name. `site` is it.
  - `unsure`: our number is not on the page; the page reader proposed `site`, but the text does not write it there. "Check by eye."
  - `not_on_site`: neither.
- `facts[].copyDisagrees` (optional): our own copy uses two values for the fact (a sentence).
- `inclusions[].item`: `parking`, `kotatsu`, `shower`, `gym`, `kitchen`, `fibre`; status `match` | `not_on_site` | `site_only`.
- `booking.status`: `match` | `mismatch` | `not_on_site`.
- `otherPrices`: what the page reader saw besides our facts (unverified; for context only).

## POST /api/research/page — read a page

Request: `{ "url": "https://…", "fresh": false }` (`url` required, public http(s) only; X / Twitter / LinkedIn refused
because Firecrawl bills them through paid providers). Cost: about 5 credits (Markdown + summary + JSON).

```json
{
  "summary": "The webpage provides comprehensive information about the Sweet Grass campground in Kita Karuizawa …",
  "url": "https://sweetgrass.jp/",
  "title": "北軽井沢スウィートグラス",
  "name": "北軽井沢スウィートグラス",
  "sellingPoints": ["多様な宿泊施設がある", "ペット同伴可", "薪焚きの体験が楽しめる"],
  "amenities": ["食材セット", "レンタルサービス", "温泉", "カフェ"],
  "claims": ["…"],
  "prices": [],
  "pricesDropped": 4,
  "audience": "…",
  "theySayWeDont": ["全宿泊施設に薪付き", "ペット同伴可", "温泉", "カフェ"],
  "sources": ["https://sweetgrass.jp/"],
  "note": "Their words, for ideas only. Do not copy them into a post …",
  "cached": false,
  "cost": { "firecrawlCalls": 1, "fromCache": 0, "credits": 5 }
}
```

- `prices`: only prices the page text writes as yen; `pricesDropped` counts the reader's numbers that are not on the
  page (on sweetgrass.jp all four were invented).
- `theySayWeDont`: their points, claims and amenities our approved copy never mentions (a local word check), plus
  "They mention <amenity>; your copy does not." lines.

## POST /api/research/events — local events

Request (optional): `{ "days": 30, "fresh": false }` (`days` 1–90). Three Japanese web searches (嬬恋村, 軽井沢,
群馬 吾妻 草津) naming the months in the window. Cost: ≈ 6 credits.

```json
{
  "summary": "6 events near Tsumagoi, Karuizawa and Gunma between 2026-11-09 and 2026-12-09, and 7 pages to check for dates.",
  "window": { "from": "2026-11-09", "to": "2026-12-09", "days": 30 },
  "queries": ["嬬恋村 イベント 2026年11月 2026年12月", "…"],
  "events": [
    { "title": "湯畑ツリー＆イルミネーション2026 - 草津温泉", "url": "https://www.kusatsu-onsen.ne.jp/event/2029.php", "source": "kusatsu-onsen.ne.jp",
      "snippet": "…", "place": ["草津"], "dates": ["2026-11-21"], "range": null, "first": "2026-11-21", "postBy": "2026-11-18",
      "why": "On 2026-11-21. Post a reel by 2026-11-18 while people plan the trip." }
  ],
  "undated": [ { "title": "嬬恋村のイベント | (一社)嬬恋村観光協会", "url": "https://www.tsumagoi-kankou.jp/event", "place": ["嬬恋"], "dates": [], "range": null,
                 "why": "No date in the search text: open the page to check when it is." } ],
  "sources": ["https://…"],
  "note": "Dates come from the search text; confirm on the event page before you plan a post around one.",
  "cached": false,
  "cost": { "firecrawlCalls": 3, "fromCache": 0, "credits": 6 }
}
```

- Dates are read from titles and snippets (2026年11月20日, 令和8年11月20日, 11月20日, 11/20(金), Nov 20, ranges
  11月14日～2月28日). A weekday written beside a date, or a 令和N年度 / 20XX年度, fixes its year, so last season's pages drop out.
- `events` are sorted by `first` (the first date inside the window; for a range already running, today).
  `range` is `{from, to}` or `null`. `postBy` = 3 days before `first`, never before today. `undated` holds up to 10
  pages that name a place but no date.

## POST /api/research/links — link check

Request (optional): `{ "fresh": false }`. Checks every link in **planned and scheduled** posts (`/api/posts`: the
post's live `url` and the URLs in its drafts `post.txt` / `post.md`) and in the profile kit. Each link is pinged
straight from this PC (HEAD, then a small GET; free). A site that refuses robots (401/403/429) is retried through
Firecrawl (1 credit each, at most 5 a run; never X or LinkedIn). Cost: usually 0.
Private back-office pages kept in the log as proof of a booking (Google Business, X drafts, TikTok Studio, LINE Manager, LinkedIn admin) are not checked.

```json
{
  "summary": "All 21 links that could be checked load; 1 sites refuse automatic checks, open those by hand.",
  "checked": 22,
  "broken": [],
  "unsure": [ { "url": "https://www.linkedin.com/company/142923144/admin/page-posts/published/", "status": "blocked", "code": 403,
                "why": "the site refuses automatic checks", "usedIn": ["post #9 (connect-1108-long on linkedin, scheduled)"] } ],
  "links": [ { "url": "https://tsumagoi.kensaur.us/reserve?utm_source=x&utm_medium=social", "status": "ok", "code": 200, "why": "loads",
               "usedIn": ["post #14 (carstay-1108 on x, scheduled)"] } ],
  "sources": ["https://…every link checked…"],
  "cached": false,
  "cost": { "firecrawlCalls": 0, "fromCache": 0, "credits": 0 }
}
```

- `links[].status`: `ok` | `broken` | `blocked` (could not be checked automatically; shown in `unsure`). `code` is the
  HTTP status or `null` (no connection). `broken` and `unsure` are the same rows as in `links`, filtered.
- With broken links the summary names up to five: "1 of 22 links are broken: https://… (page not found, in post #3 (…))."
- A site that answers 200 for every path (a single-page app) cannot show a missing page this way.

## MCP

`server/mcp.mjs` exposes the same five as read-only tools (`research_ideas`, `research_site_check`, `research_page`,
`research_events`, `research_links`). See `docs/mcp.md`.
