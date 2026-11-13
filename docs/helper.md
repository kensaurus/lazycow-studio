# The browser helper: scheduling on X, TikTok, Google Maps, LINE and LinkedIn

X, TikTok, Google Maps (Business Profile) and LINE (a message to all friends) give the studio no posting API. For these, the studio drives
your own, signed-in Chrome (`server/helper.mjs`) and schedules the post the way you would by hand: it attaches the
reel's file, writes the approved text, sets the date and time, checks what the site shows, presses
Schedule, and checks that the site took it. Then it marks the post **scheduled** in the posting log with a
link where you can see it.

A file over 48 MB goes as a lighter copy (same size and frame rate, kept in `renders/share-cache`), because the Chrome link cannot carry more; the original is untouched.

Only **approved** reels are scheduled. Approving stays with a person in the studio.

## Which browser: your own Chrome

The helper works in **your own Chrome**, the one already signed in to X, TikTok, Google, Facebook, LINE and
Pinterest. It connects through the **Playwright extension** ("Playwright MCP Bridge",
[Chrome Web Store](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm)),
the same one Playwright MCP's `--extension` mode uses. It opens no second browser.

How it connects (`server/chrome-bridge.mjs`, a port of the relay in playwright-core 1.65.0,
`src/tools/mcp/cdpRelay.ts` and `cdpRelayV2.ts`):

1. The studio starts a small relay on `127.0.0.1` (a random port, an unguessable path).
2. It opens the extension's page `chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html?mcpRelayUrl=…`
   in your Chrome, in the profile that has the extension.
3. **You click once:** on that "Playwright" tab, press **Allow & select** next to the same tab. To skip even
   that click, copy the line `PLAYWRIGHT_MCP_EXTENSION_TOKEN=…` shown on that page (the copy button) into the
   studio's `.env`. From then on it connects by itself. The token is a key to your browser: keep it out of
   chats and commits; regenerating it on that page cancels it.
4. The helper then works only in **new tabs of its own**, gathered in a tab group named
   "Playwright · Lazycow Studio". It never closes or navigates a tab it did not open, and the relay refuses
   any command that would close your browser. Another Playwright client (for example an AI agent using
   Playwright MCP) keeps its own group and its own tabs alongside it.

Settings › Accounts then shows the real sign-in state of your Chrome. It reads which session cookies exist
(their names only, never their values). **Sign in to all at once** becomes "connect, then open a sign-in tab only
for a site your Chrome is really signed out of".

`STUDIO_HELPER_BROWSER` in `.env` chooses:

| Value | Browser |
| --- | --- |
| empty (default) | your Chrome when the extension is installed; otherwise the helper's own window, and Accounts says why |
| `extension` | your Chrome; if the extension is missing it still falls back, and says so |
| `own` | the old way: a separate window with its own profile (`STUDIO_HOME/browser`), signed in once per site there |

The connect page opens in **a small Chrome window of its own**, titled "Welcome". It is not a tab: a new tab would land
next to your active tab, and when that tab sits in another Playwright client's collapsed tab group, the new tab
disappears into that group. The relay keeps waiting until you press **Allow & select** or Cancel; it has no deadline.
A job waits up to 10 minutes for the click, then stops with a plain message, but the window keeps waiting.
**Keep that window open** (minimizing is fine): closing it disconnects the helper until you press Connect again.
The helper never quietly opens a different, signed-out window instead. If a site signs you out later, the job ends with
"Sign in to … then schedule again". Nothing is scheduled or logged in either case.

`GET /api/helper` → `browser`: `{mode, setting, connected, extensionInstalled, autoConnect, pending: {since, until, message} | null,
lastError: {at, message} | null, error, note}`. `POST /api/helper/connect` (`{cancel?: true}`) starts connecting, or opens the
Welcome window again, or cancels, and answers at once with `{ok, browser}`. `POST /api/helper/signin` and `/api/helper/post`
also answer at once while it waits (`{pending: true, message}` / `{state: "connect", message}`).

## What it automates, per network

Times are given with their zone (`2026-11-16T19:00+09:00` = 19:00 JST).

| Network | Opens | Sets the time in | Checks before pressing | Presses | Counts as done when | Proof link |
| --- | --- | --- | --- | --- | --- | --- |
| X | `x.com/compose/post` | this computer's clock (19:00 JST = 18:00 on a Singapore PC) | the text is in the box; the dialog says `Will send on Fri, Nov 13, 2026 at 6:00 PM`; the upload says `<file>: Ready`; the button says **Schedule** | Schedule | the post box closes | `x.com/compose/post/unsent/scheduled` |
| TikTok | `tiktok.com/tiktokstudio/upload` | this computer's clock | the upload is done and the cover has loaded (TikTok resets the description when it does); the description and every #tag are there; the 投稿のタイミング section shows the date (`2026年11月13日`) and time (`18:00`); the button says 投稿予約する | 投稿予約する | TikTok moves on to `/tiktokstudio/content` | `tiktok.com/tiktokstudio/content` |
| Google Maps | `business.google.com/posts/l/<listing id>` (opens Google Search's "Add post" box) | the listing's own zone, the time as written (12:00 JST stays 12:00) | the text, the **Book** button link, the schedule switch, the date (`13/11/2026`) and time (`12:00`) | Post | the box closes; the list shows `Scheduled 13 Nov` | `business.google.com/posts/l/<listing id>` |
| LINE | `manager.line.biz/account/<id>/broadcast/create` (text bubble, then a video bubble) | this computer's clock (LINE shows the zone, e.g. UTC+8: 19:00 JST = 18:00) | the text in the first bubble, the video in the second, 予約配信 on with the date (`2026/11/09`) and time (`18:00`); the confirm box must name that same date and time | 配信予約, then 配信 in the confirm box | the page leaves the editor | the 配信予約中 list (`manager.line.biz/account/<id>/broadcast`) |

What gets posted comes from the reel's files (Prepare files): the network's own folder, the cut **with**
music (never `_no-music`), and its `post.txt` with the link tagged for that network. Google Maps uses
`cover_1200x900.jpg`, and the last line `ボタン：予約 → https://…` becomes the Book button's link instead of
text.

**Which listing (Google Maps).** Put the listing's id in `.env` as `STUDIO_GBP_LOCATION` (business.google.com/locations
shows it, and it is in the address of the listing's pages). Without it, the helper reads the locations page and
uses the id when there is exactly one listing; with several it stops and asks for the setting.

## Rules it keeps

- **Approved reels only.** Anything else is refused before the browser opens, and again when the job's
  turn comes (the review may have changed while it waited).
- **No duplicates.** The same reel on the same network at the same moment is refused if the posting log
  already has it planned, queued, scheduled or posted (a dropped or failed post frees the slot). Times are
  compared as moments, so `19:00+09:00` and `18:00+08:00` are the same slot.
- **Inside the site's window.** At least 15 minutes ahead, and at most: X 365 days, TikTok 10, Google Maps 180, LINE 180, LinkedIn 90 (`CHROME_NETS` in `server/editor.html`).
- **One helper job at a time.** Jobs queue; the Log and the job badge show each step.
- **It checks before it presses.** If what the site shows differs from what was asked, it stops without
  pressing, says what it saw, and leaves the page open for you.
- **A failure stays visible.** On success the tab closes; on anything else it stays open.

## Reading the numbers (performance)

`POST /api/perf/collect-browser` ([perf-api.md](perf-api.md)) reads how each post did off the network's own pages,
in your Chrome. It runs as one helper job, read-only. Each reading is stored like a typed one, marked `browser`.

| Network | Where it reads | How it finds the post |
| --- | --- | --- |
| X | the post's page, or your profile's timeline | its link, else its time (within 20 min) and opening words. The counts come from the post's action bar (views, likes, replies, reposts, bookmarks), in English or Japanese |
| TikTok | the TikTok Studio content list, then the video's analytics page when its id is known | the list's own data, by video id, time or caption |
| Pinterest | the pin's page | the pin id in the log's link; the page's data, else its stats panel (impressions, saves) |
| Google Maps | the listing's posts page | the page's data, by time or text |
| LinkedIn | the page's admin post list (the log's link) | the page's data, by time or text |

When a post is found for the first time, its own link goes into the posting log. The hourly timer starts this job
only while the helper is already connected to your Chrome. What cannot be read is listed with the reason, and stays
in the to-do list for typing or a CSV.

## Plan a week

`POST /api/helper/schedule-week` spreads approved reels over the next days (7 by default, up to 14): one post
per network per day at 19:00 in the audience's zone (`STUDIO_TZ`), Google Maps at 12:00 on Fridays and
Saturdays only. It skips days a network already has a post, never gives a network the same reel twice, and
never puts the same headline (the reel's title) on one network on two days in a row. It answers with the plan
first; nothing happens until it is sent again with `confirm: true`, which queues one helper job per row.

## API

`POST /api/helper/schedule` `{slug, network: "x"|"tiktok"|"gbp", at: "2026-11-16T19:00+09:00", id?, rehearse?}`

- `id`: a planned post (from the posting log) this fulfils; it becomes scheduled instead of adding a row.
- `rehearse: true`: every step but the final press; nothing is scheduled or logged.
- 200: the queued job (`{slug: "helper-<slug>-<network>", kind: "helper", status: "queued", label, …}`). Its
  progress comes over `/api/events` (`job`) and `GET /api/job?slug=helper-<slug>-<network>`. When it ends,
  `job.result` is `{state: "scheduled"|"rehearsed"|"signin"|"failed", message, proof: {url, shown, seen}, postId}`
  and `job.status` is `done` (scheduled or rehearsed) or `error`.
- 409 `{error}`: refused, with the reason in a plain sentence (not approved, already scheduled at that time,
  too soon, too far ahead, no file, already being scheduled).
- 400 `{error}`: a missing or malformed field.

`POST /api/helper/schedule-week` `{slugs?, networks?, start?: "YYYY-MM-DD", days?: 1-14, confirm?}`

- Answers `{dryRun, start, days, timeZone, plan: [{slug, network, at, day, headline, job?, refused?}], skipped: [{day, network, why}], notApproved: [slug]}`.
- With `confirm: true`, each row carries its queued `job`, or `refused` when a last check stops it.

The MCP tool `schedule_reel` (`{slug, network, at, rehearse?}`) does the same as the first call, and checks
the review status itself first.

## Limits

- **Sites change.** The helper follows each site's page as it was on 2026-11-09. When a site moves a
  button, the helper does not guess: a check fails, it stops before pressing, and the message says what it
  saw. Scheduling by hand in the open tab still works.
- **It cannot see your other tools.** A post scheduled by hand on the site is not in the posting log unless
  you add it, so the duplicate check cannot know about it.
- **Proof is the site's own list.** X and Google Maps are checked against their scheduled lists; TikTok's
  proof is that it moved on to its content page.
- **Google Maps posts can take 24-48 h** to show on Maps after they go out.

**LINE notes (2026-11-09).** A video over 48 MB cannot be handed to Chrome by the extension, so the helper takes the
first cut that fits (the vertical LINE cut, else the 4:5 Facebook one). LINE's buttons do not answer a pointer click
from the helper, so it clicks the visible button directly; with a time set the send button reads 配信予約. Every
failed step saves a picture of the page in `STUDIO_HOME/helper-shots/line-*.png`.
