# Third-party notices

Lazycow Studio stands on other people's open work. This file lists what it uses, under which licence, and what that means for you. Licences were read from the installed packages on 2026-11-08 (`node_modules/*/package.json`, `venv/Lib/site-packages/*.dist-info/METADATA`); run `npm ls` and `pip show` to check your own install.

## Read this first: Remotion is not MIT

[Remotion](https://www.remotion.dev) (the `remotion` and `@remotion/*` packages that lay out the words on screen) uses the **Remotion License**, not an open-source licence:

- **Free** for individuals, non-profits, for-profit companies with **up to 3 employees**, and for evaluation.
- A **company licence** is required for larger for-profit organisations. See [remotion.dev/license](https://www.remotion.dev/license).
- You may not resell or relicense a modified Remotion.

If you run the studio for a company with more than three people, buy a Remotion company licence before making reels with it.

## The studio's own code

The code in this repository (`server/`, `py/studio/`, `src/`, `shared/`, `test/`, `scripts/`) is © kensaurus LLC and contributors, under the [Apache License 2.0](LICENSE). The names and icon are not: see [TRADEMARKS.md](TRADEMARKS.md).

Remotion is a dependency you install with `npm ci`, not part of this code, so its licence applies to you as the person running it, not to this repository's licence.

## Copyleft and other notes

Checked on 2026-11-11 with `npx license-checker@25.0.1 --summary` (npm) and the studio venv's package metadata (Python). No GPL or AGPL package is installed. Weak copyleft only, all used unmodified and installed by you, never shipped in this repository:

| Package | Licence | Comes with |
|---|---|---|
| mediabunny, @mediabunny/aac-encoder, flac-encoder, mp3-encoder | MPL-2.0 (file-level) | Remotion |
| soxr | LGPL-2.1-or-later | librosa (resampling) |
| certifi | MPL-2.0 | HTTPS certificates |
| tqdm | MPL-2.0 and MIT | progress bars of other packages |
| libheif (inside pillow-heif), LibRaw (inside rawpy) | LGPL-3.0; LGPL-2.1 or CDDL-1.0 | the wheels you install |

Others worth knowing: caniuse-lite (CC-BY-4.0, browser data used by the bundler), argparse (Python-2.0, permissive). `@remotion/compositor-*`, `@remotion/media`, `@remotion/sdk` and `@remotion/studio-protocol` declare no licence field; they are part of Remotion and fall under the Remotion License.

## JavaScript (npm)

| Package | Used for | Licence |
|---|---|---|
| remotion, @remotion/cli, @remotion/google-fonts | On-screen words, layout, render | Remotion License (see above) |
| @remotion/captions | Caption timing helpers | MIT |
| react, react-dom | Remotion compositions | MIT |
| zod | Checking reel files | MIT |
| budoux (Google) | Natural Japanese line breaks | Apache-2.0 |
| typescript (dev) | Type checking | Apache-2.0 |
| world-atlas 2.0.2 (dev; Mike Bostock) | Country outlines for the long-video maps, cut once by `scripts/geo-crop.mjs` | ISC |
| topojson-client 3.1.0 (dev; Mike Bostock) | Reading world-atlas's TopoJSON in that script | ISC |

## Python (studio venv)

| Package | Used for | Licence |
|---|---|---|
| torch, torchvision (CPU) | Runs the footage-search model | BSD-style (torch: Apache-2.0 and BSD parts) |
| open_clip_torch | Footage search and tagging (CLIP) | MIT |
| opencv-python-headless | Faces, framing, frames | Apache-2.0 |
| numpy | Numbers | BSD-3-Clause (plus 0BSD, MIT, Zlib parts) |
| pillow | Images | MIT-CMU (HPND) |
| pillow-heif | iPhone HEIC / AVIF photos | BSD-3-Clause (bundles libheif, LGPL-3.0) |
| rawpy | Camera RAW and DNG | MIT (bundles LibRaw, LGPL-2.1 / CDDL-1.0) |
| librosa | Beat tracking for cuts on the music | ISC |
| soundfile | Reading audio | BSD-3-Clause |
| scenedetect | Finding cuts in long clips | BSD-3-Clause |
| colour-science | Colour grading maths | BSD-3-Clause |
| certifi | HTTPS certificates | MPL-2.0 |
| pytest (dev) | Tests | MIT |

## Models

| Model | Used for | Licence and source |
|---|---|---|
| CLIP ViT-B/32, OpenAI weights, through OpenCLIP | Footage search, tags | MIT ([openai/CLIP](https://github.com/openai/CLIP), [mlfoundations/open_clip](https://github.com/mlfoundations/open_clip)) |
| LAION aesthetic predictor v1 (`sa_0_4_vit_b_32_linear.pth`) | "How good does it look" tie-breaker | MIT ([LAION-AI/aesthetic-predictor](https://github.com/LAION-AI/aesthetic-predictor)) |
| YuNet face detector (`face_detection_yunet_2023mar.onnx`) | Consent flags and Blur faces | MIT ([opencv/opencv_zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet)) |

Every model runs on your own computer. No footage is sent anywhere to be tagged unless you set an OpenRouter key yourself (Log page shows every paid call).

## Tools you install yourself

| Tool | Licence | Note |
|---|---|---|
| [FFmpeg](https://ffmpeg.org) | LGPL-2.1+, or GPL-2.0+ for builds that include x264 | The studio calls the `ffmpeg.exe` you put in `STUDIO_DATA\bin`; it does not ship one. If you redistribute a GPL build, its terms apply to that binary. |
| [Python](https://www.python.org) | PSF License | |
| [Node.js](https://nodejs.org) | MIT | |

## Fonts (in `public/fonts`)

Reels use the Japanese and English pairs in `shared/type-kits.json`; long videos use the display faces. All come from
[google/fonts](https://github.com/google/fonts). The copyright holder is the one each licence file names.

| Font | Copyright (from its licence file) | Licence | Licence file |
|---|---|---|---|
| Shippori Mincho | The Shippori Mincho Project Authors (FONTDASU) | SIL OFL 1.1 | `OFL-shipporimincho.txt` |
| Zen Old Mincho | The Zen Old Mincho Project Authors | SIL OFL 1.1 | `OFL-zenoldmincho.txt` |
| Zen Kaku Gothic New | The Zen Kaku Gothic Project Authors | SIL OFL 1.1 | `OFL-zenkakugothicnew.txt` |
| Zen Maru Gothic | The Zen Maru Gothic Project Authors | SIL OFL 1.1 | `OFL-zenmarugothic.txt` |
| Dela Gothic One | The Dela Gothic Project Authors | SIL OFL 1.1 | `OFL-delagothicone.txt` |
| Klee One | The Klee Project Authors (Fontworks) | SIL OFL 1.1 | `OFL-kleeone.txt` |
| Yuji Syuku | The Yuji Project Authors (Kinuta Font Factory) | SIL OFL 1.1 | `OFL-yujisyuku.txt` |
| Kaisei Decol | The Kaisei Project Authors | SIL OFL 1.1 | `OFL-kaiseidecol.txt` |
| DotGothic16 | The DotGothic16 Project Authors (Fontworks) | SIL OFL 1.1 | `OFL-dotgothic16.txt` |
| Cormorant Garamond | The Cormorant Project Authors | SIL OFL 1.1 | `OFL-cormorantgaramond.txt` |
| Playfair Display | The Playfair Display Project Authors (Reserved Font Name "Playfair Display") | SIL OFL 1.1 | `OFL-playfairdisplay.txt` |
| DM Sans | The DM Sans Project Authors | SIL OFL 1.1 | `OFL-dmsans.txt` |
| Jost | The Jost Project Authors | SIL OFL 1.1 | `OFL-jost.txt` |
| Bebas Neue | Dharma Type | SIL OFL 1.1 | `OFL-bebasneue.txt` |
| Anton | The Anton Project Authors | SIL OFL 1.1 | `OFL-anton.txt` |
| Barlow Condensed | The Barlow Project Authors | SIL OFL 1.1 | `OFL-barlowcondensed.txt` |
| Caveat | The Caveat Project Authors | SIL OFL 1.1 | `OFL-caveat.txt` |
| Fraunces | The Fraunces Project Authors | SIL OFL 1.1 | `OFL-fraunces.txt` |
| Bodoni Moda | The Bodoni Moda Project Authors | SIL OFL 1.1 | `OFL-bodonimoda.txt` |
| Cinzel | The Cinzel Project Authors | SIL OFL 1.1 | `OFL-cinzel.txt` |
| IBM Plex Mono | IBM Corp. (Reserved Font Name "Plex") | SIL OFL 1.1 | `OFL-ibmplexmono.txt` |
| VT323 | The VT323 Project Authors | SIL OFL 1.1 | `OFL-vt323.txt` |
| Special Elite | Astigmatic | Apache License 2.0 | `LICENSE-specialelite.txt` |

The full licence texts ship beside the fonts in `public/fonts`. The OFL lets you use, embed and redistribute the fonts, not sell them on their own.

The interface itself uses your operating system's own font.

## Map data (in `public/geo`)

The long-video series maps (`src/SeriesMap.tsx`) draw country outlines from [Natural Earth](https://www.naturalearthdata.com) 1:50m Admin 0 countries, which is in the **public domain** (crediting is optional; the YouTube description says "Map data: Natural Earth"). The outlines come through [world-atlas](https://github.com/topojson/world-atlas) 2.0.2 (ISC, © 2013-2019 Michael Bostock; the licence text is `public/geo/LICENSE-world-atlas.txt`), cut down to East Africa and the Gulf by `scripts/geo-crop.mjs` into `public/geo/east-africa-50m.json`. `shared/countries.json` lists the country names and ISO numbers from the same file. `shared/geo/world-110m.json` (made by `scripts/geo-world.mjs` from the same package's 1:110m countries) lets a Google Maps Timeline import name the country of any place offline. Place pins are approximate park, gate and airport positions the studio keeps in `py/studio/vlog.py` (`PINS`), or the ones you type in the trip notes.

## Icons

The interface icons are inline SVG drawn in the style of, and in several cases taken from, [Lucide](https://lucide.dev) (ISC License, © Lucide Contributors; parts © Cole Bemis, Feather, MIT).

The social-network marks (YouTube, Instagram, TikTok, Facebook, Threads, X, LINE, Google Maps, Pinterest, Bluesky, note, Xiaohongshu) are from [Simple Icons](https://simpleicons.org) 15.22.0 (CC0-1.0); the LinkedIn mark is Lucide 0.460.0 (ISC), because Simple Icons no longer carries it. The marks themselves are trademarks of their owners and appear only to label which network a file or post is for.

## Brand artwork (`server/brand`)

The Lazycow app icon and the two mascot illustrations were generated on 2026-11-08 with **Recraft V3** through [fal.ai](https://fal.ai), then recoloured to the studio's moss green. The SVG files keep their C2PA content credentials, which record that they are AI-generated. The PNG, ICO and maskable sizes are exported from those SVGs with ffmpeg. Check fal.ai's and Recraft's current terms for generated output before registering "Lazycow" or the icon as a trademark.

## Music and sound effects

Tracks come from [Openverse](https://openverse.org) (Freesound, Wikimedia Commons, Jamendo and others) and are limited to **CC0** and **Public Domain Mark** works, or were made by the studio. Each file's creator, licence and source page are kept in the audio library, shown in the Audio tab, and written to a `credits.txt` that travels with every delivered reel. Credit is not legally required for CC0, but the studio gives it anyway.

## Services the studio can talk to (only when you connect them)

- **YouTube Data API v3** (upload, schedule, playlists): Google's [API Terms of Service](https://developers.google.com/terms).
- **Google Photos Picker API** (pick items to import): same terms.
- **Openverse API** (find CC0 music): [Openverse terms](https://docs.openverse.org/terms_of_service.html).
- **OpenRouter** (optional paid tagging): its own terms; off unless you add a key.
