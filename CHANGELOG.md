# Changelog

All notable changes to Lazycow Studio. Versions follow [Semantic Versioning](https://semver.org); dates are JST.

## 0.14.1 (2026-11-13)

### Added
- **Long videos sound and look finished.** `python -m studio quality scan` measures every picture's sharpness (its
  sharpest part too), every clip's shake and wind. A plan and a build leave out blurry and too-shaky pictures; each
  clip's wind is turned down (nobody speaking) or cleaned (speech); the music dips for speech, not breezes; the music
  bed always covers the film (new AI music, then pieces already paid for, then free CC0 tracks) and a build that asked
  for music and has none stops; every label, note and chapter title is checked against its frame; the description
  credits the real music and lists the wildlife seen; a soft whoosh marks each chapter. The quality check reports
  captions, wind and the music's source.
- **The Problems list catches more**, each with a button: a post booked but not seen live hours after its time (with
  **Look on Google Maps** and friends), a sign-in that ends before posts booked after it (red up to two weeks ahead;
  Bluesky's lasts about two weeks), a network whose measured posts reached nobody yet, and a network booked through
  your Chrome that nobody has checked is signed in (LINE, Pinterest).
- `README.ja.md`: the essentials in Japanese.
- `packages/lazycow`: the npm README shows the studio and lists all 27 MCP tools by area (a test keeps it complete).

### Changed
- **Posting** leads with one panel, "Before these go out", instead of five differently styled boxes; a post not seen
  live comes first with **Book again / It is out / Set aside**, and Runs by itself's settings stay folded.
- Day cards on Posting show the reel's first frame, its words, the network and the time; the file name is small.
- **Results**: booked is the quiet part of each bar and posted carries the colour; how predictions work and the table
  fold under one plain line; Latest posts and Keys & AI draw without waiting on a cold Python process.
- Words in tags and chips are set in the UI face at 12 px (figures stay mono). The needs-you strip no longer covers
  the page heading and moves away while you scroll. Footage shows the Google account as `ke…@gmail.com`.

### Fixed
- Posting › Sent and Results › Out and booked counted bookings that had been swapped for a new version: Sent said 36
  (21 real) and YouTube showed 65 booked (29 real).
- Results said "Higher scores went with better results by -0.58": it now says better, worse or no clear link by the
  sign. The first comparison date lost a stray comma ("Mon 16 Nov,.").
- `research_ideas` searched the original workspace's place (Tsumagoi, Gunma, in Japan's results) for every project
  without a topic; it now searches the open project's own name and home place, in that country. `research_events`
  without a home place answers 400 with where to set one (it was a 500).
- The header showed "Tsumagoi Work&Camp" before a project loaded.
- The `lazycow` package's author is an object (`name` + `url`). npm read the string form's first parentheses as the
  URL, so `lazycow@0.14.0` on npm shows "Kenji Sakuramoto" as the author link; the next version links https://kensaur.us.

## 0.14.0 (2026-11-13)

The first public release.

### Added
- **The `lazycow` npm package** (`packages/lazycow`), by kensaurus, Apache-2.0 with the NOTICE inside:
  - `claude mcp add lazycow -- npx -y lazycow mcp`: the studio's MCP server with nothing to clone. It finds the studio's
    port and API token by itself (`STUDIO_PORT` / `STUDIO_API_TOKEN`, else the `.env` in `LAZYCOW_DIR`, else the folder
    the double-click setup recorded), so an agent config never holds the token.
  - `npx lazycow install`: downloads this version's release zip, refuses it unless its SHA-256 is the one built into the
    package, unpacks it and starts the double-click setup. `npx lazycow open | status | api <METHOD> <path>`.
  - `import { createClient } from "lazycow"`: a typed client for the HTTP API (`health`, `overview`, `posts`,
    `problems`, ... and `request()` for any route in docs/openapi.yaml), with plain `StudioError`s.
  - Listed in the official MCP Registry as `io.github.kensaurus/lazycow` (`server.json`). A release workflow publishes
    the package with npm provenance (trusted publishing, no stored token) and lists the registry entry.
- The README's first screen says what it is, why and for whom, with the agent setup in three lines.
- **MCP tools return `structuredContent`** next to their text (a list as `{ items }`), so programs can read the data
  without parsing it. Every one of the 27 tools is now tested end to end, through the studio's server and the npm package.
- An unknown `/api/...` route answers JSON (`no such route: GET /api/x`, with where the list is) instead of a bare "no".

### Fixed
- **Local events** searched Japanese words in Japan's results for every project. They now search where the project's
  home place is: the country from its map point (offline), English words outside Japan.
- The MCP server reads the studio's port from its `.env` too, not only from `STUDIO_PORT`.
- **Series playlist privacy:** linking a series made its playlist public even when the parts were unlisted, and a
  public playlist shows anyone the unlisted videos in it. The playlist now follows the most private part, and a
  playlist of that name that is more open is closed to match.

### Changed
- The public copy holds no personal notes, trip details or names from the maintainer's own projects; the export stops
  if any come back.

## 0.13.0 (2026-11-13)

### Security
- **Critical:** a web page could send you to a studio address that ran its own script inside the studio (the
  "connected" note after a sign-in put the address's text on the page as HTML). That script could approve and post
  reels and read your keys. The note now takes only a network the studio knows, and escapes it.
- Links that come from data (post addresses, research sources, music pages) open only web, mail or in-page addresses,
  so a `javascript:` address can never run on a click. Text escaping now covers single quotes too.
- No other site can show the studio inside a frame (`X-Frame-Options: DENY`, `frame-ancestors 'none'`), so nobody can
  line Approve or Post up under a decoy button.
- The API token is no longer written to `server.log`; it is printed only in a terminal.
- A shared project file can no longer point a reel at a network share (`\\host\share`), a drive path or `..`: those
  reels are left out on import, and the engine never opens a network share as footage. Looking at one made Windows sign
  in to that host with your account.
- The drop box: two phones sending a file with the same name at once corrupted the photo and stopped the studio. Each
  upload now writes its own temporary file, and an error answers that phone instead of ending the server.
- The studio logs an unexpected error and keeps running instead of stopping every booked post with it.
- A pasted key can no longer add another line to `.env`; sign-in codes are passed as `--code=` to the engine; a project
  name in `/api/project` must be a reel name.
- Dependencies: Remotion 4.0.543 with zod 4.6.7 (GHSA-mrhx-c7xc-m3w5, zod could use up memory on oversized input).
  `npm audit`: 0 known vulnerabilities; `pip-audit`: none; gitleaks over the files and the whole history: no secrets.

### Added
- **Download, unzip, double-click.** A release zip with a 1997-style `README.TXT` (STEP 1 to STEP 7; there is no
  step 7, no serial number and no crack) and **Start Lazycow** (`.cmd` on Windows, `.command` on a Mac). The first run
  shows a blue setup screen, downloads pinned Node, uv/Python and (if you say yes) ffmpeg, checks each against its
  SHA-256, keeps them in your user folder without admin rights or PATH changes, installs hash-locked Python packages
  (`py/requirements-win.lock`, `-mac.lock`), runs the studio's own setup, makes a desktop and Start menu shortcut and
  opens the studio. Run it again and it carries on where it stopped. Also experimental Pinokio scripts.
- **Problems that stay until they are fixed.** The bell's notes pass by, and a page that was closed never saw them.
  Now a red or amber button next to the bell, a strip under the header and a "What went wrong" panel keep each problem
  with its cause, what it affects and one Fix button: a booked reel that is not approved (red, it can only be fixed),
  a post that did not go out, a job that ended in an error (such as "the new version of focus-1107 was not used"), long
  videos that repeat days or vary a lot in length (amber), and a project switch (info). Checked every 5 minutes and
  after every job (`server/problems.mjs`, `GET /api/problems`).
- **The 90s pop-up tour.** Behind a blinking DO NOT CLICK button (end of the setup guide, and Ctrl K): Lazy Kenji
  explains every page in 1999-style pop-up windows that keep coming. Close one and two come back. Capped at 9 open and
  40 in all, inside the page (never real tabs); Esc or MAKE IT STOP ends it. Slow? Just close the browser.
- **Where you went, from Google Maps Timeline.** Long videos › step 1 › "Bring in where you went": export Timeline on
  the phone (the steps are on the card), choose the file, and the studio keeps this trip's days only: each place with
  when and how long you stayed and its country (worked out offline from Natural Earth outlines), and the legs between
  them (drive, flight, walk; how far, how long; the real road). Home and work, raw GPS and Wi-Fi scans are never kept,
  and the file you chose is deleted. Google's file has no place names, so you type them, with a "See it in Google Maps"
  link per place, and choose which appear. The series maps then draw the real road, place tags say "2 nights", and each
  episode's description lists the day's stops ("4 h 20 min drive · 212 km → River Camp · 2 nights"). Android,
  iPhone, older Takeout files and GPX (`py/studio/timeline.py`, `/api/vlogs/timeline`, `timeline import|show|choose|forget`).
- **A trip as a series** of long videos. Set **Length of each episode** (5-15 minutes, default 10) and the studio cuts the
  trip into the fewest parts the footage can fill at that length, each day in exactly one part, in story order, all in one
  look. Each part opens on its own strongest moment, recaps the part before, puts its title over a map of the trip with
  its leg drawing itself, opens each chapter with a place tag (day of the trip, place, country, the border crossed, a
  small map; a flight's arc on a travel day) and ends on a card for the next part with room for YouTube's end screen.
  Its music follows its place in the story; long clips may give two or three moments. The series is the first option;
  the other films are under **More looks (separate films, not a series)**.
- Series on YouTube: upload privately with captions, then **Link the series** (the playlist in order, and links to the
  part before, the part after and the playlist in every description) and post the pin comments. A **Do in YouTube
  Studio** checklist links each part's end screen, comments and visibility pages, with a tick per step.
- Trip notes: a **Country** per day, the trip's time zone, each camera's clock, and a route with approximate pins for
  the maps (country outlines from Natural Earth, drawn offline). `vlog plan --series --target --titles`,
  `vlog clocks`, `youtube link-series`, `youtube series-comments`; `POST /api/vlogs/series-links`.
- **Lazy Kenji**, the kensaurus pixel cast's Kenji on a cow-print bean bag, replaces the sleepy cow: he waves on the
  first start, naps while nothing is being made, lounges when there is nothing to review, gives a thumbs up when videos
  are ready and points at tips. Each empty state's hint is his speech bubble, and he walks you through the setup guide.
- **Support Lazycow**: pay once (any amount, yen or dollars) or monthly as Supporter, Backer or Sponsor, through Stripe.
  The monthly plans add small, real benefits: your GitHub issues labelled and looked at first, a vote on what is built
  next, and Sponsors' logos in the README and the About window. See SUPPORTING.md; the About window links every plan
  and the cancel page. The old GitHub Sponsors link pointed at a listing that does not exist.

### Changed
- The drop box page names the open project (or "this computer") instead of the ranch.
- `.gitignore` also keeps out `.env.*` (but `.env.example`), `*.log` and `secrets/`.

### Fixed
- Long videos count days in the trip's own time when the trip notes give one: a clip filmed after midnight belongs to
  the next day, and photos from a camera set to another country's clock land on the right day and in the right order
  next to the clips.
- A day you noted a moment for ("A birthday by the river") ends on it in a series: its own chapter, in your words, from that
  day's pictures of people. Before, clips came first and an episode named after the moment could leave it out.
- After a re-plan, the Long videos page offered to upload the earlier plan's greyed-out builds ("Upload 4 ready parts"
  next to "0 ready to upload"). Only parts built from the current plan can be uploaded now, on the page and by the server.
- A series description keeps a first chapter that starts inside YouTube's 10-second minimum (it was folded into the cold
  open), and `python -m studio ...` prints UTF-8, so a Windows terminal no longer crashes after a build on "▶ Next".
- The research link check resolves names and follows no redirects, so a public-looking address cannot reach this
  computer or the local network.

## 0.12.2 (2026-11-12)

### Fixed
- Packaging: a network whose earlier copy Google Drive has locked for good (not even readable) keeps that copy and the
  other networks are made, so "Use the new version" still makes the reel live. Its post shows in Needs a look if it
  cannot read the file.
- Long-video thumbnails: words that name no animal ("A Hot Air Balloon") were laid over the clearest animal, an elephant.
  The picture now has to show the words (a clear match); when none does, the thumbnail says the other half of the title
  over a picture that shows it ("Leopards in the Grass").
- A re-cut whose swapped shot shows a face (as the build measures it) in a reel that keeps faces out is no longer offered:
  the library had marked those clips face-free, so using the new version suddenly needed a consent tick.
- Approval leaves out a draft file Google Drive has locked, with a note, instead of failing.
- "Use the new version" on a version that shows faces, for a reel with no consent yet, now stops before anything
  changes and asks for Consent OK. Before, it put the new files live and then the approval refused, leaving the reel
  unapproved so its bookings would not post.

## 0.12.1 (2026-11-12)

### Fixed
- The first CI run on Linux failed tests written with Windows paths, a week plan that read a zone-less time as the
  owner's own zone, and two long-video tests that needed the search model. They now pass on any system.
- The folder allow-list folded case on every system; on Linux, where `/data/RENDERS` is another folder than
  `/data/renders`, it now compares exactly (`pathKey` in `server/trust.mjs`).
- "Use the new version" could fail at its last step on a file a page was playing; the old file is moved aside instead.
  Versions keeps listing a reel a failed Use left unapproved, so it can be pressed again.

## 0.12.0 (2026-11-12)

### Fixed
- YouTube's upload allowance read 6 a day (1,600 units an upload). Since 1 June 2026 uploads have their own allowance, 100 a
  day per Google app; the swap now takes up to 20 a day of it.
- "Use the new version" approved the bare reel name instead of its draft, so every use failed at the end and left the reel
  unapproved; it also said "is live" at the press. It now says it is being made live and reports done or failed. Packaging
  tries again for about 30 s when Drive holds a draft file it is syncing, and the sound step does the same when a player,
  a virus scan or the level check holds a finished file (`studio.held`).
- Controls overflowing and text cut off (a sweep of every page in both languages at six widths, both projects): the
  project's name was hidden at tablet width and cut to three letters on a phone, and now shows in full everywhere (tablets
  put the steps on their own row; on a phone Help moves into Search). Words is one card per line on a phone. A card's date
  strip wraps inside the card. Review keeps its word. "1 booked reels" reads "1 booked reel". A notice someone closed stays
  closed. A YouTube sign-in redirect is never cached (Chrome replayed an old error).
- Posts the studio sends itself (Bluesky, queued posts) went out only for the open project: a ranch post was missed while
  another project was open. Every project's due posts are now sent every 5 minutes, whichever project is open.
- Booking a later time on the post panel showed "Sending…" on Post now and said "Sending to …", as if it posted at once;
  it now says "Booking…" and names the time. A missed or failed post now offers the next free slot, not the missed time.
- A re-cut whose run was closed mid-render stayed "making" for ever; after 45 minutes it counts as interrupted and the reel
  can be re-cut again. A re-cut search that finds no clearly better shot is remembered, so the same search is not offered
  again until the reel's review changes (or 14 days pass).
- ffmpeg's report was read in the Windows code page, so a Japanese file name or tag broke loudness checks and AI pricing.
- Catch-up switched off still sent late posts. "Book again" failed on a missed post. Missing YouTube and Facebook posts were
  never checked again. A "behind" cut-out could outlive the shot it was made from.
- Saving a reel from the editor dropped its AI voice, AI notes (the platform's AI label) and AI clips.
- Mixes landed 1-2 LU under −14 LUFS; the finished mix is now measured and trimmed onto it, and its true peak is kept
  under −1 dBTP after the AAC encode (encoding an encode had pushed fire crackle to +0.8 dBTP).
- The AI reviewer was not given three true facts (car-sleeping 5 vehicles a night, quiet hours from 22:00, winter
  below freezing) and flagged 39 booked reels for them. (An earlier fix in this version set YouTube's daily uploads to
  6; the first entry of this list replaces it: 100 a day since 1 June 2026.)
- Phone: the last tap targets under 24 px.

A new person can set the studio up in one command, and a project made for another brand is that brand's, not the
ranch's.

### Added
- **Several YouTube accounts per project** (`youtube accounts`, `/api/youtube/accounts`, `/api/youtube/connect?account=new`):
  the channel Shorts post to stays `main`; more channels connect beside it as a2, a3, ... (a personal channel for long
  videos, a second brand), each with its own sign-in.
- **Long videos to YouTube from the studio** (Long videos page, `youtube upload-vlog`, `POST /api/vlogs/youtube`): pick
  the account and who can see them (private, unlisted, public) or a schedule (private until each part's time, then
  public, one every N days); upload one part or every ready part. Title, description with chapters, tags and thumbnail go
  with it; the link shows on the part.
- **A second studio pinned to one project** (`STUDIO_PROJECT`, with `STUDIO_PORT` and usually `STUDIO_QUIET=1`): work on
  another project side by side without switching the main studio away.
- **Reel styles** (`shared/type-kits.json`, `py/studio/typekits.py`, `src/typekit.ts`, `/api/typekits`): every new reel
  draws a type pairing (10: Mincho classic, editorial, clean gothic, soft rounded, bold poster, handwritten journal,
  brush, decorative, condensed sport, retro pixel), colours (6), how its words arrive (typed, lines rise, pop, focus,
  wipe) and a colour grade (house, warm, cool, matte, crisp), seeded per reel and rarely repeating the last few reels.
  Night and fire reels keep the house grade. The reel editor shows all four with a "Surprise me" roll. A reel without
  these fields renders exactly as before. Eight Japanese OFL font families were added to `public/fonts` with licences.
- **Versions of a reel** (Posting › Versions, `py/studio/versions.py`, `/api/versions*`): a booked reel keeps posting while
  a better cut is made beside it. Shots the AI review found under the wrong caption are searched again with the
  caption's own words; the new cut is rendered at 9:16, checked and reviewed, and offered only when the reviewer finds
  it better. Live and new play side by side with each changed shot and the review before and after; "Use the new
  version" renders every size, approves it and swaps its bookings; "Keep the live one" discards it. Every version keeps
  why it was made and what changed.
- **Sound levels of booked reels** (Posting, `py/studio/levels.py`, `/api/levels`): reels off −14 LUFS or peaking over
  −1 dBTP are fixed in place by gain alone, one pass from the original sound with a 4× oversampled limiter; the
  masters are kept as `*.orig.mp4`; a noticeable fix swaps bookings already uploaded.
- **Long videos**: the page leads with your videos (one status line, the next step, Stop, chapters folded); a footage
  yardstick (clips, moving minutes and photos used, and how many more videos the rest can make) with "From what is
  left" videos; no moment of a clip shown twice across videos; sound that leads and trails each cut (J and L cuts);
  your own words for what happened each day, a switch for personal moments, and private-looking pictures (a hospital
  bed, a passport) held back unless you let them in; thumbnails matched to their whole phrase.
- **Restart at a safe point**: a restart asked for during a long job waits for it (a long-video chain restarts between
  two parts and carries on) instead of being refused. `STUDIO_QUIET=1` runs a studio for looking only.
- **Long YouTube vlogs from a trip** (`py/studio/vlog.py`, `src/Vlog.tsx`, `python -m studio vlog plan|build`): 5 to 10 minute,
  16:9 parts with a cold open, a title, chapters by day and long pause, the clips' own sound under a music bed, QA, YouTube
  title, description with valid chapters, and a thumbnail. Chapter names come from the pictures (a vision model: a species
  only when clear, a place only from a sign).
- **Google Photos import** streams to disk, downloads 6 at a time, and resumes after an interruption. A video copy dated
  1970 takes its creation time.
- **Public release prep**: Apache-2.0, README for a new user, CI (tests + typecheck), and an export without the ranch's files.
- **Runs by itself** (Posting, `GET`/`POST /api/autopost`, `py/studio/live.py`, `server/autoplan.mjs`): books the next
  days' posts from approved reels once a day; confirms each booked post went out (YouTube privacy, Facebook
  publish status, readings, and the Chrome reader, now also LINE's message list), flags "missing" after 6 h with a
  bell alert and a Needs a look list (Book again, It is out, Set aside); after downtime sends posts up to 2 h late
  and marks older ones missed; sets aside failures a newer booking replaced; checks sign-ins daily; starts with
  Windows (`scripts/autostart.mjs`, `scripts/launch.mjs`). Every part has its own switch.
- **Words follow the voice** (`shared/spoken.mjs`): with an AI voice, each word lights up as it is said.
- **AI tools `foley` (MMAudio V2) and `behind` (BiRefNet v2 video)**: natural sound for silent shots only; the headline
  behind the opening shot's subject.
- **Camera motion blur** on whip and zoom cuts (`@remotion/motion-blur`).
- **`npm run setup`** (`scripts/setup.mjs`): checks Node, Python, ffmpeg and disk, writes `.env` for this computer, makes
  the Python venv with every package, fetches the picture-quality model and free music, and gives the exact fix for
  anything left. `npm run setup -- --check` only reports. Windows, macOS and Linux.
- **Theme editor** (Reels › Make reels › New theme, `POST /api/themes`, `POST /api/themes/delete`): a headline, up to six
  lines, what to film and hashtags. A project with no themes says so and offers to write the first one.
- **Settings › Keys & AI › This project** (`GET`/`POST /api/brand`, `py/studio/brand.py`): name and second-language
  name for the last card, handle, link and hashtags for posts, a home place (or all footage counts), and words never
  to use. Fixed for the Tsumagoi workspace.
- **Settings › Keys & AI › Use with Claude or Cursor**: the MCP setup for Claude Code, Claude Desktop and Cursor with this
  computer's paths filled in, Copy buttons, and a link to the API description (`GET /api/openapi.yaml`).
- **Optional API token** (`STUDIO_API_TOKEN`): every caller must carry it; the browser gets it once from the address the
  studio prints. The MCP server reads it from `.env` by itself. Off by default.
- **Quality check on every render** (`studio.verify.qa`): one ffmpeg pass per master (9:16, 4:5 and 16:9) reads
  loudness (±1.5 LU of −14 LUFS), true peak (≤ −1 dBTP), black runs over 0.4 s (not the end card's last 1.5 s), still
  runs over 2.5 s (a warning: photos are still) and a silent reel when music was chosen, plus the format checks. Stored
  as `qa` in the render's `manifest.json`, one entry per aspect: `{"ok", "checks": [{"id", "level": "ok"|"warn"|"bad",
  "found", "fix"}], "measured"}`. Re-mixing refreshes it. A "bad" check only flags a reel; nothing is blocked. About
  1 s per master.
- **Colour match between shots** (project field `colorMatch`, default `true`): each shot's window is measured (Lab a*/b*
  mean and spread, luma, 3 frames) and a `colorchannelmixer` step before the look grade moves its cast half way to the
  reel's median, each channel within ±8 % and luma within ±6 %. Night and 360 shots are left alone. `false` gives the
  filter chain of before, byte for byte. Recorded per shot as `shots[].color`, the target as `colorMatch.target`.
- **Steadying handheld clips** (project field `stabilize`: `"auto"` default, `"off"`, `"on"`): the shake of each shot's
  window is measured (phase correlation on 30 fps, 320 px frames; median distance from the 0.5 s average path, in % of
  the frame); in auto, a clip at 0.20 or more gets two-pass vidstab (smoothing 15, optzoom, no black edges). Drone (DJI),
  360, photo and AI clips are never steadied. Transforms and measurements are cached per source and window in
  `DATA/mezz/stab` and `DATA/mezz/probe`. A missing vidstab or a failed pass leaves the shot as shot, with the reason.
  Recorded per shot as `shots[].stab` (`mode`, `shake`, `threshold`, `on`, `reason`). Measured shake: DJI 0.006-0.024,
  steady phone 0.10-0.18, shaky phone 0.28-0.84. Cost on a 9-shot reel (32 threads): measuring all shots 5 s (in
  parallel, cached); with no shaky clip no change (381.6 s → 379.9 s); with every handheld clip steadied (`"on"`, 4 of
  9) +42 s (+11 %).
- Tests: `py/tests/test_brand.py`, `test/env-example.test.mjs` (every variable the code reads is in `.env.example`),
  `test/openapi-routes.test.mjs` (every route is in `docs/openapi.yaml` and back), token tests in `trust` and `mcp`;
  `py/tests/test_qa.py` (stderr parsers on captured output, a black second found in a real lavfi render) and
  `py/tests/test_look.py` (clamped and identity corrections, the old filter chain byte for byte, which shots are
  steadied, cache keys).

### Changed
- **A project made in the studio is its own brand** (`config.RANCH` is the Tsumagoi workspace only): its own home place
  or none, its own themes and word bank, its name on the last card and in titles, its hashtags, link and handle in posts,
  its own copy rules, no house reels, and files named after it. The AI reviewer is told whose reel it is. The Tsumagoi
  workspace is unchanged (compared byte for byte: themes, posts, word bank, titles, tags and post text of 25 reels).
- "Create project" opens the new project straight away, without an extra Switch and "are you sure".
- Make reels starts with no theme ticked; "1 reel" reads as one.
- `/api/collect*` is now `/api/intake*` (ad blockers dropped any address ending in `/collect`); the old name still works.
- The reel count in the top bar, the page and the state filters agree (the house reels are counted nowhere).
- Settings is called Settings on both its tabs, while loading too.

### Fixed
- The page said "the studio is not answering" when a browser extension blocked one request: it now asks `/api/health`
  first and says which request was blocked.
- The current page in the top bar was dark on dark while the pointer rested on it; it now has `aria-current="page"`,
  and on a phone the page list fades at the edge that has more.
- A key the provider refuses reads "Saved, but refused", not "Saved and working".
- An automatic AI review no longer fails on every render when there is no reviewer key; it is skipped.
- A shell-exported `STUDIO_DATA` made every project write into the main project's folder.
- The last card of every reel said @tsumagoicamp, whatever the project.
- A new project's Words › Suggest, Ideas and Events, the music prompt and the profile kit no longer use the ranch's
  copy, site, search words or bios (research.approved_copy, site_url, default_topic, angle_system, wording.suggest_system).
- A render in another project overwrote the ranch's `shared/reels.json` with that project's reels; each project now keeps
  its own list (`config.PLAN`).
- Theme saves within one clock tick were not seen; `alternate_opening` crashed on a reel whose theme was gone.
- The Accounts card for TikTok showed an internal document path.

### Faster
- The reel list (`/api/overview`): 1.76 s → 0.29 s on 162 reels (one directory listing per reel instead of a stat per
  network folder on Google Drive).
- The footage check (`/api/footage/health`): 22.7 s → 0.5 s warm, same output (one catalog build per check, cached
  search phrases, folder lookups read once).

### Removed
- `py/studio/whisper_caps.py` and five functions nothing called; two unused page functions; 60 unused labels; 48 old
  style rules that later rules override in every property (checked: the computed style of every element and its
  ::before/::after is the same on six pages at three widths, about 30,000 elements).

## 0.11.0 (2026-11-10)

The studio behaves like a desktop program, not a web page.

### Added
- **Reels › Being made**: every reel rendering or waiting its turn, with time left, stop and retry, and what just
  finished. The status bar's RENDER block and the Next strip open it; sub-tabs show their counts.
- Calendar: a month at a time (‹ › Today), Saturdays cyan, Sundays and Japanese national holidays pink with their
  names (shared/holidays-jp.json from the Cabinet Office; `npm run holidays` refreshes it yearly), posts already out
  in green.
- The status bar is clickable: RENDER opens Being made, NEXT opens the schedule, the keys open the key list; hover
  and press feedback.

### Changed
- Sections in the order work moves: Footage, Reels, Posting, Results, Settings (keys 1-5 follow).
- **Footage › Where footage comes from** is always open: one row per place the studio reads (Google Drive folder,
  this PC, the studio inbox, the Google Form's folder, the Google Photos account), with where it is, how many files,
  and whether it counts as ranch footage or is placed by GPS. The drop box panel retries by itself after a failed load.
- **Results › Try next** says each suggestion as a sentence with the look and recipe by name (what they do on hover):
  "The Impact look, built as Altitude, words stacked on the left, 16-22 s long, posted 21-23 JST", tagged Not tried yet
  or Worked before.
- **Settings › Keys & AI** shows, under each key, what the studio spent with it (all time, today, calls) and what the
  provider says is left: OpenRouter's key limit or account credits, Firecrawl's plan credits and renewal date, fal's
  balance when the key may read billing. Together has no balance API; each row links to the provider's billing page.
  `GET /api/ai/credits` (cached 10 minutes, `?fresh=1` asks again; read-only). Tests: py/tests/test_ai.py.
- Pages, reels and status-bar links open in a new tab with Ctrl/Cmd/Shift-click or a middle click; right-click on a
  page tab or a reel offers "Open in a new tab".
- **Being made shows all work, live**: renders, AI touches and scoring, posting and swaps, footage checks and footage
  picking for new reels, each with progress and run time, plus what finished in the last 6 hours (errors in red). The
  board re-reads `GET /api/jobs` on reconnect and every 15 s; the status bar counts non-render work (AI 1 · Posting 2).
  Fixed: running progress of two jobs at once could drop one of them (the 200 ms throttle kept one job, now one per job).
- **Bookings keep the newest words by themselves**: a booking made before its reel got new words is swapped at the
  same time slot once the new render is approved (one at a time, every 5 minutes; YouTube 5 a day). Posting shows the
  count in plain groups (swaps next, YouTube on the next days, waits for review, rendering, booked inside LINE /
  LinkedIn / Google Maps). Bluesky is no longer counted: the studio sends it from the newest render at its time.
  `GET /api/posts/stale`, `POST /api/posts/autoreplace`.
- **Scores and predictions** (py/studio/predict.py, tests in py/tests/test_predict.py): each reel has a 0-100 score
  (AI hook and look marks, fresh headline, fitting length; partial without an AI review) on its card and review row;
  each booking gets a predicted range (x a typical post on that network, 80 %) frozen when it is made, and Results sets
  it beside the actual result with how often reality lands inside. "Score with AI" runs as one server job.
- **Drag and drop, arrange**: drop photos and videos from the computer onto the studio (`POST /api/footage/upload`,
  shared `saveUpload` with the drop box; test in test/dropbox.test.mjs); drag panels by their grip or Alt+↑/↓, fold
  them by double-click; page changes slide (View Transitions; never with reduced motion).
- **Make reels › Surprise me** rolls a random batch (themes with footage left, footage window, cut); batches pressed
  while one is picking wait their turn, and the server makes one theme per call and queues each render at once (a big
  batch used to time out after 10 minutes and lose its reels).
- **Editor › AI**: tick touches, see the price per tool and in total against the limits, add and render; an approved
  reel's touches go onto a `-ai` copy. Fixed: the tab could price the previously open reel.
- **Stylesheet folded into cascade layers** (docs/plan-antislop.md C1): the first four design passes sit in
  `@layer legacy`, later passes win by their place; `!important` 480 -> 57. Computed from a simulation of the cascade
  over every element in 1,581 states and checked in Chrome: identical computed styles on every page, dialog and editor
  tab at desktop and phone width.
- Fixed: re-rendering a reel with V2 layers failed at "invalid literal for int(): 'L0'" (the cleanup of old shot clips
  read the layer clips' names as shot numbers); test in py/tests/test_reel_specs.py.
- The work list is re-read right after the page starts any work, so a new job shows even if its live event is late.
- The editor's AI tab says when the AI status is slow and offers Try again (it stayed on "Loading" before).
- The automatic swap counts a swap only when it succeeded (for X and TikTok: the old booking off and the new one
  booked); a failing booking waits 10 min, then 1 h, and stops after 3 tries, listed on Posting with its error and
  "Try them again". Bookings already past are no longer listed as "within 30 minutes". Rules in server/swap.mjs,
  tests in test/swap.test.mjs.
- A reel that finishes rendering gets its AI score by itself (reviewer's hook and look; priced against the AI limits),
  so new reels do not stay with a partial score.
- Results laid out again (owner: "containers are placed weird"): Out and booked comes right after the latest posts,
  full width, with a **Next post** column (a network with nothing out yet shows when it starts, e.g. LinkedIn
  11/11 19:00, Google Maps 11/13 12:00); the learning progress sits inside "What worked" beside "Try next" at the same
  height; the CSV import is a fold-out at the bottom. Phones show network, posted, booked and next.
- Footage starts with one line (where footage comes from · collect from others · fresh footage left); each opens its
  panel beneath, one at a time, remembered. The clips come right after. Owner: "collect footage is eating a lot of
  visual estate".
- Reels no longer repeats the next post as a big card (it is in the status bar and on Posting); the lead appears only
  when reels wait for review. Only a finished render says "ready to review" (the hourly numbers read said it too).
- A test now fails when a label is defined twice (two `sb.` labels had silently replaced the status bar's wording).
- Anti-slop pass (docs/plan-antislop.md): no sparkle or wand glyphs; a palette sampled from the ranch's own reels
  (sky, larch, meadow, ember, fire); reel words in Shippori Mincho; one focal panel per page; Posting in one row
  (Calendar, List, All reels, Sent; YouTube and Research as side links); Reels opens with what goes out next and what
  waits for review.

- **Footage › Collect footage**: a drop box for phones on this Wi-Fi (QR code, no app or account, files go straight to
  this computer; LAN-only server/dropbox.mjs with a secret link, photo/video types only, closes itself) and a Google
  Form helper (uploads use the owner's Drive storage). Neither uses the senders' storage. Tests: test/dropbox.test.mjs.
- **Posting › Schedule › Calendar**: weeks from this Monday to the last booking, one square per booking with its
  network's logo (solid = booked on the network, dashed = the studio sends it, amber = reminder to post by hand, red
  underline = headline repeats there). Click opens the booking. Days or Calendar is remembered.
- The posting drawer shows the post as the network will: account, time, cover, the text with hashtags and links picked
  out, and its length (Bluesky checked against its 300).
- Drag a dashed (studio-sent) or amber (reminder) square to another day on the calendar: same time of day, one post per
  network a day, at least 15 minutes ahead (POST /api/posts/move, posting.move). Squares booked on a network say to
  move them there.
- `npm run app` opens the studio in its own window (Chrome or Edge app mode) and starts the server if needed. Installed
  from the browser, the header becomes the window's title bar (Window Controls Overlay).
- Status bar: what is rendering and the time left, what goes out next, and the keys for the current screen.
- Keys: 1–5 for sections, `[` `]` for tabs; on To review, J/K move, A approves, N draws new words, Space plays.
- Right-click menu on reels (Open, Approve, New words, Where it is booked, Copy its name).

### Changed
- Monokai accents on the light theme: bright colours (Monokai Pro) are text only on the black frame and solid blocks
  behind black type on paper. Yellow = you are here / keys, green = done / go, cyan = next / info, pink = attention,
  orange = rendering, purple = help. The main button is a black block with a green arrow that fills green on hover;
  selected tabs carry a yellow underline. A WCAG check of every page passes.
- Ideas is no longer a section of its own: it is **Posting › Research**. Nothing it finds feeds the reels (they use only
  approved words and the site's facts); it is reading for posting decisions: trends, events nearby, the website check
  and the link check.
- Terminal chrome: the header, status bar and editor pane tabs are near-black with paper text (about 17:1 contrast),
  amber for "you are here", green for live, red for trouble. Sections are numbered 1–5 in the header, matching their
  keys. The status bar leads each part with a mode block (READY / RENDER / OFFLINE, NEXT) and shows keys as keycaps.
- Panels and posting days carry a title strip like a window's (ink, mono capitals).
- The arrow cursor everywhere (the hand only on links that leave the app); no stray text selection or image dragging;
  no rubber-band scrolling; thin ink scrollbars inside panes.
- A reel's title is its own headline, so cards and lists no longer all read like their theme.

### Fixed
- Countdowns, the header's Next and "went out" were an hour early for posts stored without an offset (the PC is on
  Singapore time, the audience on Japan time). Stored post times are now read as this computer's time everywhere, and
  new ones are stored with their offset (posting.with_offset).
- To review keys follow the reel, not a row number: the outline survives refreshes and A / N act only on the reel you
  can see outlined.
- Render progress no longer re-renders other pages every second (no stutter, open sections and typing focus kept).
- Words asks for its data once at a time; Keys shows a loader instead of "no keys" while it loads; a link to a reel
  that does not exist says so; Escape closes About; `[` `]` step through sub-tabs too; wide tables scroll inside
  themselves on phones.
- Text on pictures and low-contrast text (WCAG check of every page).
- On phones, the "screen not ideal for editing" notice only shows in the editor; Make reels stacks.

## 0.10.0 (2026-11-10)

The studio's own security review, a design pass, and the repeated-words fix carried through to what is booked.

### Added
- **Replace booking** (Posting): a booking made before its reel's latest render says so. Facebook and YouTube swap it
  by API at the same time; X through your Chrome (take it off, book the new one in the same slot); Bluesky sends the
  new render by itself. "Replace N now" does the soonest first (YouTube five a day, for its upload allowance).
- Plan posts never books a headline already on that network within two weeks, and says when it leaves a slot empty.
- 23 new headlines and 13 new lines in the word bank (drafted from approved copy, each checked against the fact rules).

- **Reels › To review**: every reel waiting for a person on one row (shots, words, checks, a player) with Approve,
  New words and Open.
- Words also suit their pictures (no ridge in the dark, no winter over summer, a night line over mostly dusk or night
  shots, autumn leaves over autumn) and every reel keeps at least one word on its theme.
- The render queue survives a restart (renders/queue.json): the interrupted render resumes first.

### Changed
- **Design: the console grammar** (docs/DESIGN_DOCTRINE.md › App surfaces) across every page: paper and ink, radius 0,
  ruled sections instead of floating cards, one primary (an ink frame with vermilion ticks), ink cells for whatever is
  selected, square status tags, mono figures, a numbered masthead.
- Dependencies pinned to versions at least two weeks old: Remotion 4.0.539, playwright-core 1.64.1; npm audit clean.
- Words: a screen row is at most 14 characters; one reel never states the same fact twice; seasonal lines follow the
  month a reel posts in; rewording avoids headlines booked near it on the same networks.

### Fixed
- Security (server/trust.mjs): a slug starting with "-" could reach Python's command line as an option; posting
  routes refuse unapproved reels up front; other websites' GETs are refused; bodies capped at 8 MB; bad byte ranges
  answer 416; a slow share copy no longer freezes the server.
- The AI model name was invalid, so Ideas angles and word suggestions always fell back to templates.
- A Facebook booking could be logged as scheduled with no video id; found and booked again.
- Changing the page no longer shows "restart the studio": open pages reload into the new page by themselves; only
  server code asks for a restart.

## 0.9.0 (2026-11-10)

Reels stop repeating themselves, and a second picture track.

### Added
- **Words** (Reels › Words): one bank of approved lines. New reels draw fresh words, never another reel's set, with their own caption, title, hashtags and layout. Lines can be added by the owner, or drafted by AI from approved copy and used only once approved. Cards, the editor (**Draw new words**) and the posting schedule show repeats.
- **The bell**: the next post with a countdown, what happened (live, failed, booked), a toast when a post goes live or fails, desktop notifications on request, and a summary after time away.
- **Share and import a project** (one file: name, networks, profile kit, words, reel plans; no footage, sign-ins or keys). Renaming shows as editable and confirms.
- **Ideas** shows one tool at a time: angles as cards with their sources, events with a date and a post-by chip, a live waiting state, and the pages read folded away.
- **V2 layers**: B-roll cutaways and paper-print insets over the main shots, chosen at generation, shown and editable on a V2 timeline row.
- Docs: `docs/HANDOFF.md`, `docs/architecture.md` (diagrams), `docs/user-guide.md`, `docs/openapi.yaml` (OpenAPI 3.1, every route), `docs/integrations.md`, `docs/ROADMAP.md`, and research on integrations, pain points and multi-layer editing.

### Changed
- The cut rhythm varies per reel on the same music (on-beat lengths chosen per reel, one longer hold).
- The fact guard also bans 満天 and 光害, as the website does.
- README: "How each network gets posted", the six themes it was missing, and the current pages; `.env.example` lists `FIRECRAWL_API_KEY`, `STUDIO_RESEARCH_DAILY_CAP` and `STUDIO_PERF_STEER`.

### Fixed
- After a studio restart an open page could show "0 posts" and every network "nothing yet": a failed load now keeps the last data and says so, pages show a loader until their data arrives, and the page reloads itself after an update.
- Ideas angles and word suggestions now use the AI key saved in Settings (inside the daily budget); before, they silently fell back to templates.
- An unapproved reel could be posted through `/api/publish` or uploaded to YouTube; both now refuse. A queued post whose reel went back to review waits instead of failing.
- Saving a reel in the editor dropped when it was made (and so how recent its words were).

## 0.8.0 (2026-11-10)

Plan posts now really schedules, 21 new cut styles, and every page was walked through as a first-time user.

### Added
- **21 new cut styles:** whip, zoom through, ridge, slats, iris, jump, colour flood, pulse, mix, spin, cube, glitch (real RGB split), film burn, shutter, window, photo dump, stop-motion, freeze, mirror, impact and through-the-words. See "Cut styles" in the README.
- **Approve all** on Reels (press twice; consent is ticked where people are on camera).
- **Plan posts books for real** on every network, with an **Everything** range, and uses each waiting reel once.
- **How many more reels** today's footage allows, on Reels, Make reels and Footage.
- Footage health: reuse, cameras read from each file, what to film next.
- LinkedIn company-page scheduling through your Chrome.
- Posting in three tabs: Schedule, All reels, Sent.
- Numbers on the log's overview link to where they live; the daily AI cap can be changed in place.
- Results says when the first real comparison is due.

### Changed
- The header shows the mark only; the name and version are in an inverted footer. Finished setup no longer shows a counter.
- Reels shows 14 to a group and Footage opens two groups of 16 until asked for more. "To check" notes appear only on reels waiting for review.
- The activity log uses plain words ("loud-1108 · Bluesky", "Making a reel") instead of job ids. Importing a CSV is folded away on Results.
- All dialogs fit the window and scroll inside themselves, down to phone width.
- Card pictures are small copies made once, and a running render no longer rebuilds the whole page.
- One post per network per day is enforced by the planner, with LinkedIn and LINE at most weekly. People stay off Google Maps.
- When following results, the learner chooses among styles that have data; its exploring turns try the new ones.

### Fixed
- Through-the-words opens with readable words even when the picture behind them is dark.
- Mirror is never picked at random: it folds people in two. Choose it by hand for landscapes.
- Accounts said Facebook was Ready when its sign-in had expired: it now asks Facebook.
- A post whose time has passed counts as posted, on Results and Posting.
- A refused post no longer holds its day in the planner.
- A video over 48 MB goes through the Chrome link as a lighter copy instead of failing.
- Plan posts prepares a reel's missing files for any network.
- Ideas: the link check skips private back-office pages; list pages are no longer shown as events; the place's own pages, and pages naming it, are not cited as trends; "Look it up again" really looks again; a page that cannot be read says so.

## 0.7.1 (2026-11-09)

### Added
- **YouTube posts only to this project's channel:** `STUDIO_YT_CHANNEL` (an @handle or channel id). Signing in to any other channel is refused with a plain sentence, and an upload checks again first.
- **Daily AI budget in Settings,** next to the per-reel and total limits, with meters for today and for all AI so far.

### Changed
- Keys & AI: keys are one ruled list (state, Change key), the YouTube card starts with where Shorts go, and a brand account is named as the channel's own account.
- Accounts: networks that post through your Chrome say what they need (connect Chrome, sign in on Chrome, or check once); while Chrome is not linked they sit inside the one Connect box instead of seven identical cards. Long labels no longer squeeze the account name.
- The Settings pages read YouTube's state again when opened, so a sign-in made in another tab shows.

## 0.7.0 (2026-11-09)

The studio now posts from your own Chrome, learns from how each reel did, and keeps AI on a short leash.

### Added
- **Six sections in the order work moves:** Reels, Footage, Ideas, Posting (Plan & schedule, YouTube channel), Results (How reels did, Activity log), Settings (Accounts, Keys & AI). Old links still work.
- **Use my Chrome:** the helper drives your own signed-in Chrome through the Playwright extension (one Allow & select per studio start, or none with the token in `.env`). No second browser, no passwords.
- **Schedule it for me** on X, TikTok and Google Maps (`/api/helper/schedule`, `/schedule-week`, MCP `schedule_reel`): approved reels only, no duplicates, checked before the final press.
- **Results:** numbers per post from YouTube, Facebook and Bluesky (hourly), from TikTok, X, Pinterest, Google Maps and LinkedIn pages in your Chrome, or by hand / CSV. What helped and what held back, with how sure it is, and what to try next (Thompson sampling, 30 % exploring).
- **Ideas:** Firecrawl research: trends and post angles, events nearby, website vs your reels, read a page, check links.
- **AI assist** (opt-in, priced before it runs, per-reel and total caps): reviewer, slow motion, sharpen, music for a reel, Japanese voice, living photo. YouTube uploads with AI voice or moving photos are flagged as altered content.
- **Keys & AI:** paste a key once (checked, never shown again); spending limits; the YouTube Google app and account (pick your own Google app file, choose the account every time).
- Reels grouped by kind, stage or week; a hand-drawn Lazycow mark and icon set.

### Changed
- YouTube sign-in always shows Google's account chooser, returns to the studio's own port, and shows which account is connected.
- Light, high-contrast look: paper, hairline rules, Mincho titles, square tags, one set of motion timings (off under reduced motion).

### Fixed
- "Mark posted" kept overwriting a scheduled post's real time; it now keeps the time it went out.
- The Results page no longer replays its opening animation on every refresh.
- Facebook finds a Page kept in a business portfolio.

## 0.6.1 (2026-11-09)

The Accounts page says what to do next.

### Changed
- **Accounts** is grouped by what you need to do: *Needs one step* (one button per network), *Ready* (and how each one gets posted), and *Not used* (folded away). A count bar sits on top; each card's on/off switch and account name are under Settings; the profile kit folds away at the bottom.
- The browser helper's networks are explained once, with **Sign in to all at once**, which opens every sign-in page in the helper window. A network moves to Ready once the helper window is signed in (the studio checks only that the sign-in exists, never its contents).
- Threads gets a short tip: it signs in with Instagram or Facebook, one Threads profile per Instagram account.

### Fixed
- **Facebook**: a Page kept in a business portfolio (the kind you post to from Business Suite) is now found. The studio asks for business_management and looks in the business's own Pages when Facebook's list is empty, and the message says exactly what to tick.

## 0.6.0 (2026-11-09)

One-click setup, connecting and posting, in plain words.

### Added
- **Sign in with Bluesky**: Bluesky's own page opens, you press Allow, and you are back, connected (atproto OAuth with PAR, PKCE and DPoP; the session lasts two weeks, then one press signs in again). The app password stays under "Other way" and never runs out.
- **Connect with Facebook**: paste your Meta app's ID and secret once, then one button opens Facebook's own window and the studio keeps the Page's non-expiring key. Pasting a key stays under "Other way".
- **Browser helper** for networks the studio cannot post to by itself (LinkedIn, Threads, TikTok, X, Pinterest, Google Maps, LINE): one press opens the network in a Chrome window the studio drives, attaches the video and writes the post text. You check it and press Post there. Sign-ins in that window are remembered. Installs itself with one click the first time.
- **MCP server** (`npm run mcp`, `server/mcp.mjs`): AI assistants such as Claude Code can see reels, posts and accounts, make reels, plan posts and post approved reels. It refuses any reel that is not approved. Setup in `docs/mcp.md`.
- **Setup guide**: on first launch, one plain step per screen (language, computer check, footage, first reels, time zone, YouTube, accounts, first post), each with a "Do this now" button. The Getting started ring reopens it.
- **Fix it button**: a problem message that names its fix (sign in again, connect an account, free space, time zone, footage folder) gets a button that goes straight there.
- **Posting health** on the Posting page: one chip per network that says how it gets posted (studio, helper, connect once, sign in again soon, needs attention) and the next or last post.
- **Four picture looks**: `film` (moving grain, a warm light leak on each cut, slight gate weave), `punch` (hard zoomed cuts, a speed ramp, a flash on each caption), `split` (shots in pairs on a split screen, each half marked 春夏秋冬 from when it was filmed) and `ember` (firelight from below, rising sparks).
- **Four word recipes**: `countdown` (a big number beside each line, 3 to 1), `timeline` (shots run morning to night under a 朝 昼 夕 夜 rail), `pov` (typed-out words with a blinking caret) and `altitude` (the headline counts up to 標高1,444m). A `loop` option dissolves the first frame in at the end so a replay has no seam.
- **Six new themes** that use them, listed in Make reels: reasons, day, seasons, pov, nightfire, altitude. "Vary the look" now also draws a picture look.
- Research notes behind the looks, with dated sources: `docs/research/2026-11-08-reel-effects.md`.

### Changed
- The time zone is picked from a list in the setup guide; no `.env` editing.

### Fixed
- Saving a reel in the editor keeps its picture look and word recipe instead of falling back to the theme default.

## 0.5.0 (2026-11-08)

Find anything, ask in plain words, and help everywhere.

### Added
- **Search or do anything** (Ctrl/Cmd+K, `/`, or the search box in the top bar): actions, pages, reels, networks, projects, help and footage in one list, recent first, keyboard-first (WAI-ARIA combobox).
- **Plain-language commands**, worked out on this computer in English or Japanese: "post carstay on TikTok tomorrow 7pm", "明日19時にTikTokに投稿", "make autumn reels", "show scheduled posts", "drone footage". The suggestion only opens the right place, already filled in; nothing goes out until you press the post panel's button.
- **Help**: eleven short articles (English and Japanese), each with a button to the place it describes; `?` opens help, questions such as "how do I schedule a post" lead with the best article; a keyboard shortcuts tab.
- **Getting started in the top bar**: a progress ring on every page until setup is done (now including connecting an account).

### Changed
- Every hover hint is now a real tooltip: it appears on keyboard focus too, can be hovered, and Esc hides it (WCAG 1.4.13).
- Facebook connects with a Page admin's user token and keeps the Page's own token, which does not expire.

## 0.4.0 (2026-11-08)

Several projects, posting from the studio itself, and an Accounts page.

### Added
- **Projects**: one studio for several brands or clients. Each project has its own footage folder, reels, drafts, posts, logins and networks; the coloured name chip beside the logo opens the list (switch, rename, colour, new project, take off the list). Switching restarts the studio on that project. The list lives in `STUDIO_HOME/workspaces.json` (default `~/.lazycow`); the `.env` setup is the "main" project.
- **Post from the studio**: connect Bluesky (handle + app password) or a Facebook Page (Page ID + Page token) once on Accounts, then the post panel has Post now and Schedule. Facebook keeps the schedule itself; for Bluesky the studio sends it at the time (checked every minute). A refused post stays in Posting as failed, with the reason.
- **Accounts page**: what the studio can post to, each network switched on or off for this project with the account that posts there, and the profile kit (name, bio, link) with copy buttons.
- **One-click hand-off** for networks the studio cannot post to yet: copies the text, saves the file and opens the upload page.
- **Lighter copies for upload limits**: `POST /api/share` takes `fit` (MB) and makes a same-size, lower-bitrate copy once when a file is over it.
- `STUDIO_PORT` runs a second studio beside the first.

### Changed
- Each page has its own colour in the top bar, and the header carries the project's colour.
- Threads is set up (@tsumagoicamp); the "not joined yet" warning is gone.

## 0.3.0 (2026-11-08)

More posts a day, simpler making, and posting to the other networks.

### Added
- **Make reels, made simple**: two numbered steps, a coloured card per theme, Select all / Only themes with new footage / Clear, a "No new opening shot" badge and a warning when the library is too small; the rest under More options.
- **Vary the look** (on by default): each new reel takes a different text layout than its theme's usual one, and effects on or off.
- **Render queue panel**: how many, total time left, when it finishes, what is happening now, each reel's progress, the error with Try again, Stop all.
- **Several posts a day**: each network has its own slots (`postTimesJst` in channels.json: TikTok 3 a day, Shorts / Facebook / Threads / Bluesky 2, X 3, LinkedIn weekly…); the post panel and Plan posts fill them, approved reels only by default.
- **Hand-off links** (`POST /api/share`, `/share/<token>`): a network's upload page in this browser can take a draft file without a file picker; one token per file, 15 minutes, nothing else reachable.
- **Getting started** checklist on a new studio; the workspace name is a setting (`STUDIO_WORKSPACE`).
- Login tokens are kept in the macOS Keychain or the Linux Secret Service (owner-only file as a fallback); Windows keeps DPAPI.

### Changed
- Posting lists the reel that goes out next at the top.

## 0.2.0 (2026-11-08)

Posting, per-network cuts and the Lazycow identity.

### Added
- **Post panel** on the Posting page: a network's square opens the file, the post text, the network's upload page, Mark posted, "Scheduled on <network>", a reminder or a real YouTube schedule, and Next reel.
- **See the live post**: once a post is out or booked, the panel leads with View post (YouTube thumbnail) and an editable link; Recently posted lists what went out.
- **Plan posts**: a week (3–14 days) for every network at once, one post per network per day, weekly networks on their own day.
- **Per-network cuts**: Make reels › Cut › Long explainer (40–60 s, a caption on every claim) for LinkedIn and Facebook; each network gets its own post text.
- **More networks**: Google Maps (Business Profile), LINE VOOM, LINE message, Pinterest, Bluesky, Xiaohongshu. Prepare files makes a new network's files for a reel that is already rendered.
- **Audience time zone** (`STUDIO_TZ`): times are picked, saved with their offset and shown in the viewers' zone.
- Real network marks (Simple Icons, Lucide), a tabbed Log (overview, how reels were made, activity, posts), Footage grouped by shoot, month, season, camera or tag, metadata pills, a Synced / Refresh indicator.
- **About Lazycow**: version, build, author and credits in the app; NOTICE, TRADEMARKS.md, CITATION.cff, share image and structured metadata.

### Changed
- Pages and data are sent gzipped and thumbnails revalidate (ETag, 304): the page is 3× and the footage list 13× smaller on the wire.
- Same-size files for several networks are hard-linked instead of copied; networks switched off (Instagram) are not packaged.

### Fixed
- YouTube schedules were read in the computer's zone (Singapore), an hour off for Japan.
- A theme that borrows another reel's copy got that reel's LinkedIn text.
- The post panel showed stale text after re-packaging.

## 0.1.0 (2026-11-07 – 2026-11-08)

First version used at the ranch: footage library with search and tags, autopilot reels per theme, on-the-beat cuts, face blur, 360° reframing, YouTube scheduling and playlists, the system check, live render progress, crash-safe editing, English / 日本語, and the Lazycow name and icon set.
