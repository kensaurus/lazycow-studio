# Anti-Slop Burndown — Lazycow Studio UI (server/editor.html)

_Audit only (2026-11-10). Nothing changes until a phase is approved._

## Scope

- Surfaces audited: [x] Prose (on-screen copy) [x] Visual [x] Code (the stylesheet) [x] Structure / IA
- Judged against the owner's chosen direction: light paper pages, a black terminal frame with Monokai accents,
  game / desktop-program feel, minimal, high contrast. And against the generic AI-dashboard look.
- Evidence: every page and window screenshotted at 1366 and 390 px today (scratchpad `ui/`), plus a scan of
  `server/editor.html`.

## Short answer

It is **not** generic shadcn/Tailwind slop any more (no violet gradients, no rounded floating cards, no emoji, no
filler words). But it is **not one of a kind yet** either. The frame is a borrowed look (a terminal plus the Monokai
editor palette), applied the same way to every section, with an icon on almost everything. That pattern is common
in 2026 "brutalist / terminal" AI-built dashboards. What only this studio has (the ranch's own footage, the Mincho
voice, Tsumagoi time and seasons) is underused.

## Slop score

| Surface   | Findings | High-recognizability | Top quick win |
|-----------|----------|----------------------|---------------|
| Prose     | 3        | 1                    | cut repeated meta lines on reel cards |
| Visual    | 7        | 3                    | drop the sparkles / wand "AI" glyphs |
| Code      | 2        | 0                    | (later) fold five stacked style layers into one |
| Structure | 4        | 2                    | Posting has four levels of tabs |

## Findings

### Prose & copy

| # | Location | Tell | Why it reads as machine-made | Recog | Effort | Direction |
|---|----------|------|------------------------------|-------|--------|-----------|
| P1 | Reel cards (`reelCard`, `w.samehook` / `w.same`) | every card repeats "Views · slug", "headline also in N other reels", the booking line, under a date chip that already says the date | over-explaining every item the same way; a person would show the one fact that matters per card | High | S | keep one line per card (the headline); move kind, slug and repeats into the hover / right-click |
| P2 | Page intros, panel hints (`.intro`, `.meta` under headings) | a full explanatory sentence under nearly every heading and control | "narrate everything" is the commonest LLM-written UI habit | Med | M | keep a sentence only where a choice has a consequence (Approve, Replace, Open the drop box); the rest go to `?` help |
| P3 | Title strips in mono capitals ("COLLECT FOOTAGE FROM OTHER PEOPLE") | long capitalised phrases as headings | caps-mono everywhere is the terminal template; long ones are hard to read | Med | S | short nouns in strips (2-3 words), sentence case for anything longer |

### Visual & UI

| # | Route / region | Tell | Recog | Effort | Direction |
|---|----------------|------|-------|--------|-----------|
| V1 | `ico("sparkles")` ×18, `ico("wand")` ×4 (e.g. editor.html:3162, 3193, 3225, 3146, 3335) | the sparkle / magic-wand glyph is the universal "AI feature" badge | High | S | name the action with its own glyph (a clapper for Make reels, a list for Next) or no glyph |
| V2 | Every page: title strip + box for every panel, sheet, posting day, window, footage health, collect | one section treatment everywhere, so every page has the same rhythm | High | M | keep strips for windows and the frame; give each page one focal element and let the rest recede (no strip) |
| V3 | Icons on every tab, button and heading | icon-per-label regardless of meaning | High | S | icons only where they carry information (network logos, state); text-only tabs |
| V4 | Monokai Pro palette (editor.html:1478) | a well-known editor theme, so recognizable as borrowed | Med | M | derive the six accents from the ranch: sky, larch-autumn orange, moss, fire, snow, dusk; keep the same one-job-per-colour rule |
| V5 | Type: Mincho titles, system sans, mono labels | three voices; the brand face (Shippori Mincho) appears only in page titles | Med | M | let the Mincho carry the reel words wherever they appear (cards, review, calendar hover), as in the reels themselves |
| V6 | Empty states (`.iempty` ×4: 3200, 4670, 4810, 4872) | icon-in-a-box + sentence, the template empty state | Med | S | show what will be there (a ghost of the queue, the month) instead of a generic icon |
| V7 | Reel card grid (Reels, 125 cards) | identical cards, equal weight; nothing is the hero | Med | M | the next post and the reels waiting for you lead (larger); the rest form a dense contact sheet |

### Code

| # | path:line | Tell | Recog | Effort | Direction |
|---|-----------|------|-------|--------|-----------|
| C1 | editor.html:837, 905, 1018, 1191, 1478 | five stacked style layers that override each other (200 `!important`) | Low (to users) / High (to engineers) | L | fold into one token set and one component layer after the visual phase settles |
| C2 | editor.html (738 KB, one file) | everything in one file | Low | L | out of scope here; note for the architecture plan |

### Structure & IA

| # | Location | Tell | Recog | Effort | Direction |
|---|----------|------|-------|--------|-----------|
| S1 | Posting | four levels of tabs (section › Plan / YouTube / Research › Schedule / All reels / Sent › Days / Calendar) plus a network filter row | High | M | one level of view switch (Calendar, List, Sent) with the network filter inline; YouTube and Research become links, not peers |
| S2 | "Next post" shown 3 times (bell, status bar, Next strip) and render progress 3 times | the same status in every corner | Med | S | one home each: the status bar for live status, the bell for history |
| S3 | Posting banner "86 bookings hold an older version…" | an operations backlog shown as the first thing on the page, in internal language | High | S | a quiet count in the schedule header that opens the swap list |
| S4 | Pagehead on every page ("01 Studio › Title") | a breadcrumb for a one-level app | Low | S | the section number and title only |

## Phased burndown

- **Phase 1 — quick, high-signal** → `enhance-web-ui`: V1, V3, P1, P3, S3, S4. Biggest drop in "machine-made" for
  the least work; no layout risk.
- **Phase 2 — identity** → `enhance-web-ui` / `design-frontend`: V4 (ranch palette), V5 (Mincho for reel words),
  V2 (one focal element per page), V6.
- **Phase 3 — journey** → `enhance-web-ux`: S1 (Posting to one tab level), S2, V7, P2.
- **Phase 4 — code** → `workflow-refactor`: C1.

## Keep (already intentional)

- The status bar as a live line with keys, the window title strips, keys 1-5 and the right-click menu.
- Solid colour plates behind text on footage; the WCAG pass on every page.
- Copy with no filler vocabulary and no emoji; one-job-per-colour rule.
- The calendar with Japanese holidays and the Being made page: product-specific, not template.

## Execution handoff

Approve a phase to run it. Re-run this audit afterwards to confirm the count dropped.

## Execution record (2026-11-10)

- Phases 1-3 (V1-V7, P1-P3, S1-S4) shipped in c60c3a9 and the follow-up commit; npm test 78 pass after each phase.
- **C1 shipped.** The first attempts (above, kept for the record) moved whole passes into layers and changed the look,
  because a layer reverses how specificity and `!important` decide. The fold that shipped was computed, not guessed:
  1. Every style rule and declaration of the stylesheet parsed (postcss): 1,685 rules, 480 `!important`.
  2. In Chrome, which selector parts match every element and pseudo-element was recorded across pages, dialogs,
     editor tabs, menus and toasts at 1366, 900 and 390 px, English and Japanese, with :hover/:focus forced on and
     off: 1,581 distinct match patterns, 1,319 of the 1,685 rules seen.
  3. The author cascade (importance, inline style, layers, specificity, order) was simulated for every pattern and
     longhand: a rule of the first four passes moved into `@layer legacy` only when no winner changed, and an
     `!important` was dropped only when no winner changed. Rules never seen keep their `!important` and stay
     unlayered when they have one.
  4. Result: 480 -> 57 `!important`, 1,169 rules in `@layer legacy` (65 blocks; layer statement first).
  5. Proof in Chrome: for 56 views (every page, dialog and editor tab at 1366 and 390 px), the full computed style of
     every box and ::before/::after (120,043 boxes) with the old sheet, the folded sheet, and the old sheet again as a
     control. No box differed except the toast in 4 views (d_d-system, m_reels, m_d-projects, m_d-search). Those 4 were
     run again with the page's toast() switched off so live events could not show one mid-check: 0 boxes changed. A
     probe that swapped the two sheets 6 times logged no toast call. So the toast was live events (renders finishing,
     swaps), not the fold.
  6. Not proven: 366 of the 1,685 rules matched nothing in any captured state. Those of the first four passes without
     an `!important` were moved into the layer with their neighbours unchecked; a static scan found 66 that could meet a
     later unlayered rule on some element. An independent check in Chrome of 5 such states (an unselected theme pill,
     a selected drive root, a pressed card action, a selected music pick, a failed network dot) found no change.
     Rules never seen that carry an `!important` stayed unlayered.
  Tools and logs: the session scratchpad's c1/ (cascade.mjs, verify2.mjs, v_*.log, toast_probe.log, fold-report.json).
- C2 stays a non-goal here (architecture plan).
