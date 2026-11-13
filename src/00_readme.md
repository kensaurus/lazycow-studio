# src

`Story.tsx` is the house reel: graded shots that cross-dissolve and push in, a reversal hook with the English in Cormorant italic, proof lines, and the 嬬恋牧場 / Work & Camp end card. Registered as `Story-9x16`, `Story-4x5`, `Story-16x9`.

Text placement comes from `shared/story-layout.mjs`. The `style` prop picks one of four layouts (`column`: vertical Mincho top-right; `centre`; `lower`: headline in the lower third, lines high; `split`: vertical Mincho top-left). Each line beat may carry a `side` (`left` / `right`) that the build measures from its shot, so a caption sits where the picture is quiet.

`looks.tsx` adds picture looks (`film` grain and light leaks, `punch` punch-in cuts with a speed ramp, `split` paired split screens with season marks, `ember` firelight and sparks) and word recipes (`countdown`, `timeline` 朝昼夕夜 rail, `pov` typed headline, `altitude` climbing counter), plus an optional `loop` ending. A project picks them with `look`, `recipe`, `kicker`, `loop`; without them Story is unchanged. List: `shared/looks.json`.

`recipes/` holds the first-cut devices (Day, Contact, Diptych, Field, Behind). They still render but the house reels use Story.
