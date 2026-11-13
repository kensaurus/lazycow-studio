# shared

- `spec.json`: frame sizes, safe zones, the ranch point (2 km radius), loudness target, tag-model prices, banned phrases.
- `channels.json`: which file goes to which network (size, frame rate, length limit, cover, who posts). Read by the packager and the editor's Exports tab.
- `layout.mjs`, `guard.mjs`: caption safe box and the fact guard.
- `story-layout.mjs`: where Story puts the hook, the lines and the end card, in four text styles (`column`, `centre`, `lower`, `split`); `lineBox(L, side)` places one caption on the left or right. Every box is checked against the safe zone by `test/story.test.mjs`.
- `looks.json`, `looks.mjs`: the picture looks and word recipes Story can layer (read by `py/studio/staging.py` and `src/looks.tsx`); `story-layout.mjs` also places their kicker, countdown number, rail, meter and season marks.
- `reels.json`: the reels' on-screen words, written by `python -m studio reels --plan` and checked by `test/story.test.mjs`.
- `looks.json` also lists the 25 cut styles (`whip`, `glitch`, `letters` …) with a plain `what` line each; `mirror` is never drawn at random because it folds people in two.
- `playbooks.json`: per-network rules (format, caption length, hashtags, links, best time, comments), from `docs/research/2026-11-09-channel-playbooks.md`. Shown on Accounts and in the post panel.
- `profiles/`: the profile kit (`profiles.json`: name, bio and link per network) with its avatar and X header images, checked by `test/profiles.test.mjs`.
