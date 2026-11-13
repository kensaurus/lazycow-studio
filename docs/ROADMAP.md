# Roadmap: pain points and continuous improvement

The studio's known pain points, what has been done about each, and what comes next, most important first. The evidence for each item, with sources and dates, is in the maintainer's dated research notes (`docs/research/`, kept out of the public copy): integrations, docs and pain points (10 Nov), multi-layer editing (10 Nov) and studio gaps (9 Nov).

**State on 12 Nov 2026 (0.12.0, unreleased).** The ranked list below was written on 10 Nov (0.9.0). Items done since then are marked in the table "Done since 0.9.0".

## Done since 0.9.0

| # | Pain | What changed |
|:--|:--|:--|
| 1 | Bluesky posts are missed when the PC is off | **Runs by itself**: the studio starts at Windows sign-in (`scripts/autostart.mjs`), sends posts up to 2 h late on start and marks older ones missed. Studio-sent posts go out for every project, whichever is open. Still open: a phone push (ntfy); the bell and desktop notifications cover the open tab only. |
| 2 | "Scheduled" is not proof a post went live | Every hour each booked post is checked on its network (`py/studio/live.py`); one not seen 6 h after its time goes to **Needs a look**. |
| 3 | Sign-outs and dying tokens are found late | A daily sign-in check warns before a Facebook token or a Bluesky sign-in runs out. |
| 4 | TikTok books only 10 days ahead | **Book posts** runs once a day (`server/autoplan.mjs`) and books TikTok 9 days ahead. |
| 9 | J/L audio | Long videos lead and trail each cut's sound (J and L cuts). Reels: not yet. |
| 12 | Public-release blockers | `LICENSE` (Apache-2.0), CI (tests and type check), and a route-coverage test against `docs/openapi.yaml` (`test/openapi-routes.test.mjs`). Still open: link check and prose lint. |
| — | Reels all looked alike | **Reel styles**: each new reel draws a type pairing, colours, word motion and grade (`shared/type-kits.json`). |
| — | A booked reel with a weak shot could not be improved without re-booking | **Versions**: a better cut is made beside the live one; a person picks, and its bookings swap at the same time slot. |
| — | One YouTube channel per project | Several accounts per project; long videos upload from the studio. |

## Done in 0.9.0

| Pain | What changed |
|:--|:--|
| Reels repeated the same words: 115 booked reels had 12 headlines and 19 sets of words, and X had one caption 6 times | **Words page** and word bank (`py/studio/wording.py`). Every new reel draws approved lines it has not used lately, makes its caption, title, hashtags and layout from them, and never repeats another reel's set. Cards, the editor and the posting schedule show repeats; **New words** and **Draw new words** fix them. |
| The word bank is small (13 headlines, 24 lines) | The owner adds lines on the Words page, or asks for AI suggestions drafted from approved copy only. A suggestion is used only after a person approves it. The fact guard checks every line, and now also bans 満天 and 光害. |
| Every reel was one row of clips | **V2 layers** (`py/studio/layers.py`, `src/Story.tsx`): B-roll cutaways over a running shot (its sound carries on, which reads as an L-cut) and paper-print insets. They show as a V2 row on the timeline. |
| Same music meant the same cut rhythm | `fit_cuts` chooses among on-beat lengths per reel and holds one shot longer. |
| An unapproved reel could be posted through the API | `publish.assert_approved()` covers Facebook, Bluesky and queued posts. A queued post for a reel sent back to review is **held**, not lost. YouTube uploads check too. |

## Next, ranked

Risk first: something wrong going out, or a post silently missing. Then manual work removed. Then what blocks a public release.

| # | Pain | Change | Size |
|:--|:--|:--|:--|
| 1 | Bluesky posts are missed when the PC is off | Autostart at logon. On start, send posts that are less than 2 h late and mark older ones `missed`. Push a phone alert (ntfy) on missed or failed posts. | M |
| 2 | "Scheduled" is not proof a post went live | About 2 h after post time, look for each post (API, or the helper's readers). Mark it `live` or `missing`. | M |
| 3 | Chrome sign-outs and dying tokens are found late | A daily sign-in and handle check per site, a Facebook `/debug_token` call and Bluesky session time left, shown on Accounts. | M |
| 4 | TikTok books only 10 days ahead | A weekly automatic **Plan posts** run (approved reels only). | S |
| 5 | One PC, no backup | A nightly backup of `catalog.sqlite`, `projects/`, `shared/` and the encrypted secrets to a second disk and Drive, plus a restore drill. | M |
| 6 | Steering on views after 3 days misses bookings | `utm_campaign=<slug>` on every link, and bookings per reel on Results. | M |
| 7 | Clips reused 8–24 times risk "unoriginal content" penalties (YouTube, Meta, TikTok rules) | Cap one clip at 3 uses per network in 30 days, and push a weekly film-next list. | M |
| 8 | Layers phase 2 | Text behind the ridge, sky text and parallax photos with Depth Anything V2 Small (Apache-2.0, 99 MB), and sticker cut-outs with BiRefNet_lite (MIT, 178 MB). People always stay whole and unchanged. | M–L |
| 9 | J/L audio and layered ambience | Lead each shot's sound in or out by a few frames, and lay a continuous ambience bed. | S |
| 10 | Cuts on a grid look machine-made | Cut on motion peaks (OpenCV optical flow at tag time), with irregular lengths. | M |
| 11 | Research angles (Posting › Research) are weak without AI | Build angles from the studio's own data: "this week last year", "worked before", "never posted", "event in N days". | S–M |
| 12 | Public-release blockers | `LICENSE` (Apache-2.0), CI (tests, link check, prose lint), and a route-coverage test against `docs/openapi.yaml`. | S–M |
| 13 | No way to plug in other tools | One outbound webhook (`reel.ready`, `post.failed`, `post.missing`, `signin.expiring`). | S |
| 14 | Editors cannot fine-tune a reel elsewhere | Export an OpenTimelineIO (.otio) timeline per reel. | M |
| 15 | Google reviews go unanswered | GBP reviews in an inbox, with replies sent only after the owner approves them. | L |

Also do, size S: retarget `line-voom` to LINE 投稿 in `shared/channels.json`, and write a how-to for using an iCloud, Drive or Dropbox folder as footage.

## The monthly loop (about 30 minutes, first Sunday)

| Step | Look at | Where | Decide |
|:--|:--|:--|:--|
| 1 | Failed or missed posts, per network | Posting › Sent, Results › Activity log | Any network failing more than twice? Fix it or pause it. |
| 2 | Sign-ins | Settings › Accounts | Sign in again before a post fails. |
| 3 | What worked | Results › What worked, Try next | Change one thing for next month. |
| 4 | Networks that earn nothing | Results per network | Two months under the median with no booking visits: post weekly or pause. |
| 5 | Footage runway | Footage › Fresh footage | Pick next month's shoot list. |
| 6 | Words | Reels › Words | Fewer than 2 approved lines per 10 reels? Add lines, or approve suggestions. |
| 7 | Review backlog | Reels › To review | More than 30 waiting? Make fewer per run. |
| 8 | AI spend | Settings › Keys & AI | Adjust the limits. |
| 9 | Platform changes | The changelogs listed in the integrations research, section 1b | Has an API opened, or a helper step broken? Add a row here. |

Keep one line per month: the date, misses, the top reel, the networks changed, and the shoot list.
