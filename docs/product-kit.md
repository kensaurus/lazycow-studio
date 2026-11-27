# Product videos from a release kit

A **release kit** is a folder of what changed in an app's release: screenshots of each screen before and after, a few short screen recordings, the changelog lines, and the brand's colours, font and logo. Lazycow Studio turns one into a product video on your own computer:

- an **App Store app preview** (iPhone or iPad, 15-30 s);
- a **Google Play promo** (16:9); or
- a **social cut**, 9:16 or 1:1.

Any tool can write a kit. [Mushi Mushi](https://kensaur.us/mushi-mushi/) exports one per release (`export_release_kit`). You can also make the folder by hand.

The render uses no AI and posts nothing. You get a file to upload yourself.

## Make one

- **In the studio:** Reels › **Product videos** (`#/product`). Paste the kit's link, or the path of a kit folder. Look through the screens; drag the before/after slider on a screen to compare. Pick a preset, press **Render**, then download the file.
- **From an agent (MCP):** `make_product_video({ kitUrl, preset, name? })` returns a video id such as `pv-quiet-notes-1-4-0--appstore-iphone`.
  - Follow it with `job_status`. When it is done, the result holds the file's path and its link.
  - `ai_estimate` (tools `["review"]`) and `ai_review` take the same id. They let the studio's AI reviewer watch the result, priced first and inside your AI limits. This is optional.
  - See [mcp.md](mcp.md).
- **Over HTTP:**
  1. `POST /api/product/kits {kitUrl}` adds the kit.
  2. `GET /api/product/plan?name=&preset=` shows the timeline without rendering.
  3. `POST /api/product/render {name, preset}` queues the render.
  4. `GET /api/product/file?name=&kind=video&preset=` fetches the file.
  - See [openapi.yaml](openapi.yaml) › Product videos.

A product video waits in the same render queue as reels, one render at a time.

## The kit

`manifest.json` follows [product-kit.schema.json](product-kit.schema.json). The same contract as a TypeScript type is [src/release-kit.ts](../src/release-kit.ts), which you can copy into the exporting side. The schema's `examples` entry is a complete kit.

```json
{
  "schema": "lazycow.release-kit",
  "version": 1,
  "app": { "name": "Quiet Notes", "tagline": "Notes that stay out of your way", "stores": ["app-store", "google-play"] },
  "release": { "version": "1.4.0" },
  "brand": { "colors": { "background": "#0f1115", "text": "#f4f5f7", "primary": "#5b8cff", "accent": "#7cf0c5" },
             "font": { "family": "DM Sans" }, "logo": { "url": "logo.png" }, "cta": "Try Quiet Notes" },
  "screens": [
    { "id": "home", "surface": "Home", "viewport": { "width": 393, "height": 852, "device": "phone", "platform": "ios" },
      "before": { "url": "home-before.png" }, "after": { "url": "home-after.png" } }
  ],
  "recordings": [
    { "id": "search-flow", "surface": "Search", "viewport": { "width": 393, "height": 852 }, "file": { "url": "search.mp4" } }
  ],
  "changelog": [{ "text": "A calmer home screen", "surface": "Home" }, "Search finds notes in under a second"]
}
```

| Field | Rules |
|---|---|
| `schema`, `version` | Must be `lazycow.release-kit`, version `1`. Unknown fields are ignored; another version is refused. |
| Screens | At most 24. Each has an `id` (lowercase, digits, dashes) and a `viewport` (size; `device` phone, tablet or desktop; `platform` ios, android or web) and an `after` picture. `before`, `caption` and `focus` are optional. |
| Recordings | At most 8, each up to 120 s and 250 MB. Their sound is dropped. |
| Pictures | PNG, JPEG or WebP, at most 25 MB and 12000 px a side. A long page capture scrolls inside the device. |
| Logo | PNG, JPEG or WebP. No SVG. |
| Font | A file (woff2, woff, ttf, otf, at most 8 MB), or the name of a face the studio already has (below). |
| Colours | `#rrggbb`. Text whose contrast with the background is under 4.5:1 is shown white or near-black instead. |
| Captions | A screen's own `caption` comes first. Otherwise the changelog line for its `surface`, else the next line not yet used. Up to four lines left over make a "What's new" card. |
| `labels` | `before`, `after` and `news` change the words the video shows, for a kit in another language. |
| Links | `https://` only, on the public internet. A relative URL is read against the manifest's own link but inherits nothing from its query string: a kit served from signed links must give each file its own absolute signed URL. In a kit folder on the computer, files are paths inside that folder. |

**Fonts the studio already has:** DM Sans (the default), Jost, Fraunces, Playfair Display, Bodoni Moda, Cinzel, Anton, Bebas Neue, Barlow Condensed, IBM Plex Mono, Zen Kaku Gothic New (for Japanese and other wide scripts) and Zen Maru Gothic.

## What the studio does with a kit

Nothing in a kit is ever run. The studio:

- Downloads each file with a size cap, then checks what its bytes really are. It never trusts a file's name or claimed type.
- Checks `bytes` and `sha256` when the kit gives them.
- Re-saves pictures as PNG, which drops their metadata.
- Re-encodes recordings to H.264 at 30 fps, with no sound and no metadata.
- Never runs SVG, HTML or a script.
- Re-checks each redirect, so a link cannot lead to this computer or your network.
- Never stores a link's query string, which holds a signed link's token.

A kit lives in `<data>/product/<name>/`, apart from your footage, which it never touches. Adding a kit of the same name replaces it and its renders.

## Presets

Every preset is in [shared/product-presets.json](../shared/product-presets.json). The studio checks the plan against the preset before rendering, and checks the finished file with ffprobe after.

| Preset | Size | Length | Look |
|---|---|---|---|
| `appstore-iphone` | 886×1920 | 15-30 s | iPhone with Face ID or Dynamic Island. The app full screen, captions on a glass band. |
| `appstore-iphone-55` | 1080×1920 | 15-30 s | iPhone 5.5" (Home button). The app full screen. |
| `appstore-ipad` | 1200×1600 | 15-30 s | iPad 13" and 11". The app full screen. |
| `play-promo` | 1920×1080 | 15-120 s | Drawn devices, a before → after reveal, a What's new card, an end card. |
| `social-9x16` | 1080×1920 | 6-60 s | The same, with captions inside the networks' safe zone. |
| `social-1x1` | 1080×1080 | 6-60 s | The same, square. |

Every preset renders H.264 High profile, yuv420p, with a stereo AAC track. Its default encoding meets its store (next section).

## Encoding

Each render's encoding is set in four layers. A layer changes only the fields it names:

1. **The preset's default**, which meets its store (below).
2. **The kit's hints**, the manifest's `encoding` (`default` for every preset, `presets` for one). A kit is someone else's file, so a hint that is out of range or unknown is left out with a warning. A kit never blocks a render.
3. **This project's default**, saved from the page (**Save as this project's default**) or with `POST /api/product/encoding/defaults`. It is kept in `<data>/product-encoding.json`.
4. **The render's own choice**, from the page's Encoding panel, `POST /api/product/render` `encoding`, or MCP `make_product_video` `encoding`.

| Field | Range | What it does |
|---|---|---|
| `rateControl` | `cbr`, `vbr`, `crf` | `cbr`: constrained CBR, one held rate. `vbr`: a target with a ceiling. `crf`: a quality. |
| `videoKbps` | 300-80000 | The target bit rate (`cbr`, `vbr`). |
| `minKbps` | 300-80000 | The floor (`vbr`, `crf`). A file that comes out under it is encoded again as constrained CBR at the floor. Under `cbr` it is the target. |
| `maxKbps` | 300-100000 | The ceiling (`vbr`, `crf`). Under `cbr` it is the target. |
| `bufsizeKbits` | 300-200000 | The VBV buffer. It must be at least 1/8 s of the ceiling. |
| `crf` | 0-51 | The quality under `crf`; lower is better. |
| `fps` | 24, 25, 30, 48, 50, 60 | The frame rate. The render's timeline is planned at this rate too. |
| `keyframeSec` | 0.25-10 | Seconds between keyframes. |
| `audioKbps` | 64-512 | The AAC bit rate. |
| `audioRate` | 44100, 48000 | The sample rate. |
| `audioBed` | `{kind: "dither"}` or `{kind: "music", id, volume}` | The sound under the picture. See [The sound](#the-sound). |

**Why constrained CBR:** libx264 ignores a minimum rate on its own, and plain VBR made 0.55 Mbps from a still screen (measured 27 Nov 2026). Under `cbr` the target, the minimum and the maximum are one rate, and x264 pads still screens with filler (`nal-hrd=cbr`). The same still screen then held 10.9 Mbps.

**The H.264 level** is the lowest level from the preset's (4.0) that fits the picture size, the frame rate, the ceiling and the buffer. For example, a 9:16 social cut at 60 fps is level 4.2. A store that caps the level (App Store: 4.0) refuses settings that need more. Under `crf` it also caps the peak rate at the level's limit: 25 Mbps and a 31,250 kbit buffer at level 4.0.

**Errors and warnings:** each store's rules are in `shared/product-presets.json` `encoding.stores`, with their source:

- **Error:** the store requires it. The page will not render, `POST /api/product/render` answers 400 with `errors` naming each field, and the check after the render refuses the file.
- **Warning:** the store recommends it. The render goes ahead, and the note is shown before and after.

| Store | Default | Requires (error) | Recommends (warning) |
|---|---|---|---|
| App Store ([spec](https://developer.apple.com/help/app-store-connect/reference/app-preview-specifications)) | Constrained CBR 11 Mbps, 11 Mbit buffer, 30 fps, a keyframe every 2 s, AAC 256 kbps at 48 kHz | At most 30 fps; H.264 up to High profile level 4.0 (a ceiling of at most 25 Mbps, a buffer of at most 31,250 kbit); AAC at least 256 kbps; 44.1 or 48 kHz; 15-30 s; at most 500 MB | A target of 10-12 Mbps (Apple: "Target bit rate"); AAC at 256 kbps, not more |
| Google Play ([YouTube upload settings](https://support.google.com/youtube/answer/1722171)) | VBR 10 Mbps, ceiling 12, floor 8, a keyframe every 0.5 s, AAC 384 kbps at 48 kHz | Nothing beyond the preset's size and length | 8 Mbps for 1080p at 24-30 fps, 12 Mbps at 48-60 fps; AAC 384 kbps; 48 kHz; a keyframe every 0.5 s (a closed GOP of half the frame rate) |
| Social | VBR 10 Mbps (1:1: 8 Mbps), ceiling 12 (1:1: 10), a keyframe every 2 s, AAC 256 kbps at 48 kHz | Nothing beyond the ranges | Nothing |

**After the render** the studio reads the file with ffprobe. It shows what it measured: the picture's and the sound's bit rates, the sample rate, channels, frame rate, profile, level and size. Each value is judged against the same rules, with a tolerance for the encoder's own rate control: 90 % for Apple's 256 kbps, 95 % for the other rates. It also warns when constrained CBR comes out more than 10 % under its target.

### The sound

- **`dither`** (the default) is a quiet bed, not digital silence. Silence encodes to about 2 kbps whatever the encoder is told, and Apple lists 256 kbps AAC. So the studio lays one-step TPDF dither (about -90 dBFS, below hearing), with the encoder's intensity and mid/side stereo off. The track measures about 253 kbps.
- **`music`** mixes a track from the audio library (Reels › Audio, by its file name) over that bed, at `volume` (0-1, default 0.5), with a 0.4 s fade in and a 1.5 s fade out. The bed keeps the bit rate up through the track's quiet moments.
  - A track whose licence is not CC0 or public domain gets a warning: make sure you may use it in a store listing.
  - A kit can name a library track but cannot send one. A named track that is not in the library falls back to the quiet bed, with a warning.

**App Store** ([app preview specifications](https://developer.apple.com/help/app-store-connect/reference/app-preview-specifications), read 27 Nov 2026):

- Previews are 15-30 s, at most 30 fps and at most 500 MB.
- [App Review Guideline 2.3.4](https://developer.apple.com/app-store/review/guidelines/#2.3.4) says previews may only use screen captures of the app itself, with text overlays. So App Store presets show the app full screen: no drawn device, no "before" screen, no title or What's new card. They use only screens and recordings of the matching device whose shape is close to the preset's.
- Upload the file in App Store Connect yourself.

**Google Play** takes its promo video as a YouTube link (Play Console › Main store listing › Video). Upload the `play-promo` file to YouTube, then paste the link there.

## Timing

| Part | Length |
|---|---|
| Title card (not in App Store presets) | 2.0 s |
| Screen with a before → after reveal | 4.6 s |
| Screen | 3.4 s |
| Recording | Its own length, 2.5-10 s |
| What's new card | 3.2 s |
| End card | 2.6 s |
| App Store last screen with the app name and call to action | 2.0 s |

- Scenes dissolve over 0.5 s.
- A short kit holds its screens longer, toward the preset's target length and at least its minimum.
- A long kit leaves out its last screens, and the plan's warnings name them.

## Licence

Lazycow Studio is Apache-2.0. It renders with [Remotion](https://www.remotion.dev), which has its own licence (remotion-dev/remotion `LICENSE.md`):

- It is free for individuals and for for-profit companies with up to 3 employees.
- **A company with more than 3 employees needs a [Remotion company licence](https://www.remotion.dev/license) to render product videos (or reels) with the studio.**

That licence is between you and Remotion. See [NOTICE](../NOTICE).
