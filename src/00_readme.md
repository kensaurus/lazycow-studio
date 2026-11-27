# src

`Story.tsx` is the house reel: graded shots that cross-dissolve and push in, a reversal hook with the English in Cormorant italic, proof lines, and the brand's end card (its name, and the account handle under it). Registered as `Story-9x16`, `Story-4x5`, `Story-16x9`.

Text placement comes from `shared/story-layout.mjs`. The `style` prop picks one of four layouts (`column`: vertical Mincho top-right; `centre`; `lower`: headline in the lower third, lines high; `split`: vertical Mincho top-left). Each line beat may carry a `side` (`left` / `right`) that the build measures from its shot, so a caption sits where the picture is quiet.

`looks.tsx` adds picture looks (`film` grain and light leaks, `punch` punch-in cuts with a speed ramp, `split` paired split screens with season marks, `ember` firelight and sparks) and word recipes (`countdown`, `timeline` 朝昼夕夜 rail, `pov` typed headline, `altitude` climbing counter), plus an optional `loop` ending. A project picks them with `look`, `recipe`, `kicker`, `loop`; without them Story is unchanged. List: `shared/looks.json`.

`ProductPreview.tsx` is the product video (docs/product-kit.md): an app's screens in a drawn phone, tablet or browser (full screen for App Store presets), slow pans and push-ins, a before → after reveal, recordings inside the device, captions from the changelog in the brand's colours and font, and an end card. Its size, fps and length come from the preset (`shared/product-presets.json`) through the timeline `py/studio/product.py` plans. `release-kit.ts` is the release kit's TypeScript type, the same contract as `docs/product-kit.schema.json`.

`recipes/` holds the first-cut devices (Day, Contact, Diptych, Field, Behind). They still render but the house reels use Story.

`Explainer.tsx` is the explainer (`Explainer-9x16`, 15-60 s): a paper page, hand-drawn strokes that draw on and boil, a highlighter for `*marked*` words, counting numbers with their source, and scene kinds `cover`, `number`, `tally`, `checklist`, `nogo`, `card`, `route`, `pair`, `thermo`, `compare`, `clock`, `bars`, `icons` (16 drawn icons), `steps`, `quote`, `end`, plus a drawn mascot sticker (`mascot` on the cover or end, idle wobble from `@remotion/noise`). `Explainer-Sheet` draws each scene's settled frame on one still (the console's preview). Props come from `py/studio/explainer.py`, which checks the script and stages its pictures into `public/explainer/<slug>/`.
