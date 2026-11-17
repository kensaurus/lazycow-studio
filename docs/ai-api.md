# AI assist API: request and response shapes

For the AI panel. Server: `server/review.mjs`; logic: `py/studio/ai.py`; render wiring: `py/studio/reels.py` (`_shots`),
`py/studio/sound.py` (`choose_music`, `mix`, `credits`), `py/studio/youtube.py` (`synthetic`); providers:
`shared/ai-providers.json` and `py/studio/providers/`; tests: `py/tests/test_ai.py`, `py/tests/test_providers.py`, `test/mcp.test.mjs`. Plan, prices and rules: `docs/research/2026-11-09-genai-reels.md`; the real
test on 10 reels: `docs/research/2026-11-09-genai-test.md`.

**The rule.** AI improves what was filmed and checks the work. It never makes a scene that was not filmed (no
text-to-video), the words stay the approved words, and nothing is approved or posted by these endpoints.

## What the UI must show

- **The cost before running.** Call `POST /api/ai/estimate` when tools are ticked; show each tool's `usd`, its
  `items[].what` (which shot, what happens), the `total`, and `refusal` when `fits` is false (disable Run then).
- **The label reminder.** When `labelRequired` (estimate) or `aiLabel` (`/api/reel`) is true, show `aiLabelNote` beside
  the post buttons. Voice and living photo set it; slow motion, sharpen and AI music do not (aesthetic edits).
  YouTube uploads set `status.containsSyntheticMedia: true` by themselves. Post text gets no AI hashtags.
- **Approved reels are never changed.** Offer "Make an AI copy" (`options.into`, e.g. `day-1108-ai`) for them; the
  server refuses tools on an approved, scheduled or posted reel without `into` (409 `locked`). The review is fine on any reel.
- **The reviewer only suggests.** Show its fixes as suggestions with a button that opens the shot or line; nothing
  is applied automatically.

## Money: one ledger, three limits

Every paid call (fal.ai, OpenRouter, Together) goes through `charge()`:

1. It is priced first: fal from `GET https://api.fal.ai/v1/models/pricing?endpoint_id=…` (cached 24 h in
   `<data>/ai/fal-pricing.json`; the table measured on 2026-11-09 is the fallback), OpenRouter from `/api/v1/models`.
2. It is refused (HTTP 402, code `cap`, nothing called) when the estimate would pass:
   - the **per-reel limit** `STUDIO_AI_REEL_CAP_USD` (default **$2.00**; counted per slug, an AI copy is its own reel),
   - the **AI total limit** `STUDIO_AI_TOTAL_CAP_USD` (default **$20**; all AI spend ever, raise it to go on),
   - the **daily budget** `STUDIO_DAILY_USD_BUDGET` (default $2; all paid calls today, research included).
3. The estimate is reserved in the `spend` table, then replaced by the actual cost (OpenRouter's `usage.cost`) or kept
   (fal does not report one). A call that fails before the provider bills it is recorded at $0.

`spend` rows: `ts, model, purpose ("ai-review" | "ai-sharpen" | "ai-slowmo" | "ai-living" | "ai-foley" | "ai-behind" | "ai-music" | "ai-voice"),
usd, tokens_in, tokens_out, note ("actual …" | "estimate …" | "failed …"), provider ("fal" | "openrouter" | "together"), slug`.
They also show on the Log page (`/api/log` → `spend`).

Limits are read from `.env` on every call, so a change from Settings applies at once (no restart).

## Errors (every endpoint)

HTTP status + `{ "error": "<one plain sentence>", "code": "<code>" }`. A key never appears in an error.

| code | HTTP | example `error` |
| --- | --- | --- |
| `cap` | 402 | That would spend $0.35 on day-1108-ai, which already used $1.90 of its $2.00 AI limit. Pick fewer tools, or raise the per-reel limit in Settings › AI. |
| `locked` | 409 | day-1108 is approved or scheduled, so AI tools will not change it. Send options.into with a new slug (e.g. day-1108-ai). |
| `not_rendered` | 409 | Render day-1108 first: the reviewer watches the finished reel. |
| `no_key` | 400 | Add your fal.ai key in Settings › AI. / Add your OpenRouter key in Settings › AI to use the reviewer. |
| `bad_key` | 400 | fal.ai did not accept the key. Paste a fresh key in Settings › AI. |
| `no_credits` | 402 | fal.ai says the account is out of credit. Top it up on fal.ai's billing page, then try again. |
| `rate_limited` | 429 | OpenRouter says too many requests right now. Wait a minute, then try again. |
| `bad_input` | 400 | tools: a list of review, sharpen, slowmo, living, foley, behind, music, voice. / Shot 3 already gets another AI tool in this run; one AI change per shot. |
| `not_found` | 404 | There is no reel project called x. AI tools work on reels made in the studio. |
| `network` / `timeout` / `upstream` | 503 / 504 / 502 | Could not reach fal.ai. Check the internet connection, then try again. |
| `bug` | 500 | AI assist stopped on a problem in the studio: <type and place>. |

## GET /api/ai: status (free)

```json
{
  "ready": true,
  "keys": { "fal": true, "openrouter": true, "together": true },
  "caps": { "reel": 2.0, "total": 20.0, "daily": 2.0 },
  "spent": { "total": 2.61, "today": 2.61, "perReel": [ { "slug": "field-1108-4-ai", "usd": 0.5845, "calls": 7 } ] },
  "byTool": [ { "tool": "living", "provider": "fal", "model": "fal-ai/kling-video/v2.5-turbo/pro/image-to-video", "usd": 1.4, "calls": 4 } ],
  "room": { "total": 17.39, "today": 17.39 },
  "tools": [ { "tool": "review", "provider": "openrouter", "model": "google/gemini-3.8-flash", "labelRequired": false,
               "what": "watches the rendered reel and suggests fixes (nothing is applied)" } ],
  "reviewModel": "google/gemini-3.8-flash",
  "reviewBasis": "video",
  "paidTagging": false,
  "summary": "AI assist: $2.61 of $20.00 spent, $2.61 today (daily budget $2.00); $2.00 per reel."
}
```

`keys` are booleans only. `paidTagging`: whether the old paid tagging has a key (see Settings below).

## The tools

| tool | provider / model | works on (automatic choice) | price (2026-11-09) | label |
| --- | --- | --- | --- | --- |
| `review` | OpenRouter `google/gemini-3.8-flash` (`STUDIO_AI_REVIEW_MODEL`); or your own `STUDIO_LLM_VISION_MODEL` from still frames (see Reviews) | the rendered 9:16 master, sent at 360x640 with its sound, plus captions, shot times, approved facts; on your own model, 12-16 frames on contact sheets instead of the video | tokens, ≈ $0.008 per 20 s reel; free on your own model | no |
| `sharpen` | fal `topaz/upscale/video/precision` (Proteus, H.264) | video shots under 1080 px on the short side, up to 3; factor to reach 1080 (x1-x4); the clip's own sound is put back | $0.01 a fal unit, 2 units a second at 1080p = $0.02 / s (2026-11-17) | no |
| `slowmo` | fal `fal-ai/rife/video` (1 new frame between each pair) | video shots at ≤ 31 fps, ≥ 2 s, not already slowed, up to 2 (longest first); played at half speed | $0.0013 / s | no |
| `living` | fal `fal-ai/kling-video/v2.5-turbo/pro/image-to-video`, 5 s | still photos (not 360), 1 by default (`max_living`); prompt allows only a slow camera move, nothing new | $0.07 / s = $0.35 | **yes** |
| `foley` | fal `fal-ai/mmaudio-v2`, 25 steps | silent shots only (a photo, AI slow motion, a moving still, a 360 shot, or a clip whose own sound is under -50 dB in the window the reel uses), up to 4 (`max_foley`); made from the shot's rendered picture at 720p; the prompt asks for the real sound of what is on screen and rules out music and voices. Kept per shot (`shots[i].ai_foley`), laid in at the shot's place with short fades, under a voice like the clip's own sound | $0.001 / s | no |
| `behind` | fal `fal-ai/birefnet/v2/video` (General Use (Light), `output_mask`) | the opening shot as rendered (no look or `ember`, no AI clip on it): its subject's mask makes a VP9 cut-out with alpha (the shot's own pixels), drawn over the headline with the same push, so the words sit behind the subject. Kept on the shot (`shots[0].ai_behind`) and used only while that shot keeps its source and length; tall sizes only | $0.000575 / compute second, ≈ $0.03 a reel | no |
| `music` | fal `fal-ai/stable-audio-25/text-to-audio` | the reel: instrumental, prompted from its mood, theme and BPM, length = reel + 3 s | $0.20 / track | no |
| `voice` | fal `fal-ai/minimax/speech-02-hd`, voice `Japanese_CalmLady`, speed 1.1 | the reel's hook and caption lines (`ja`, end card left out), one clip per line at its caption's start | $0.10 / 1,000 characters | **yes** |

- One AI change per shot. A shot taken by an earlier tool in the same run, or changed in an earlier run, is skipped by the
  automatic choice; asking for it by number is refused.
- Clip results are cached per source window in `<data>/ai/clips` (with a `.json` note): the same clip at the same moment is
  paid for once, also across reels.
- 360 shots are never changed. Shots are numbered from 0 in `options.shots`; `what` texts number them from 1.
- MiniMax Music v2 ($0.03) was not used: it needs sung lyrics, which would be words that are not approved copy.
- Together's Wan 2.7 image-to-video is $0.10 / s against Kling's $0.07 / s, so living photos use fal. The Together key is
  still checked and saved for later use.

## The provider registry: which service does each job

The table above is the default. Which service does each job is data, not code: `shared/ai-providers.json`, read by
`py/studio/providers/registry.py` and called through four protocol adapters in `py/studio/providers/`:

| protocol | how it works | providers now |
| --- | --- | --- |
| `fal_queue` | submit, poll `status_url`, read `response_url` | fal.ai (Higgsfield later) |
| `async_task` | submit a task, poll it, read the output; every path and state name comes from the registry's `task` block | Replicate, kie.ai (Runway, MiniMax, Together video, Luma, PiAPI later) |
| `sync_http` | one request; the answer's body is the file | ElevenLabs, Stability AI |
| `openai_chat` | `POST <base>/chat/completions` | OpenRouter, Together, your own model server |

**Capabilities are a closed list:** `voice`, `music`, `sfx`, `upscale`, `slowmo`, `img2video`, `bg-cut`, `llm`,
`vision` (the tools map onto them: `sharpen` → upscale, `living` → img2video, `foley` → sfx, `behind` → bg-cut,
`review` → vision). Text-to-video can never be registered: the registry refuses a capability or model that names it.
`labelRequired` belongs to the capability (`voice` and `img2video`), never to a provider, so a reel is labelled the same
whoever made the voice. A model without a commercial licence is refused; kie.ai's Suno music is marked
`"risk": "unofficial"`, is never a default, and can only be picked with `acceptRisk: true`.

What is registered (2026-11-17; **bold** = the default, exactly the tools before the registry):

| capability | models |
| --- | --- |
| voice | **fal `fal-ai/minimax/speech-02-hd`**; fal `fal-ai/elevenlabs/tts/eleven-v3`; ElevenLabs `eleven_v3`, `eleven_multilingual_v2`, `eleven_flash_v2_5`; Replicate `minimax/speech-2.8-turbo`; kie.ai `elevenlabs/text-to-speech-turbo-2-5`, `elevenlabs/text-to-speech-multilingual-v2` |
| music | **fal `fal-ai/stable-audio-25/text-to-audio`**; Stability `stable-audio-2.5`; Replicate `stability-ai/stable-audio-2.5`; kie.ai `ai-music-api/generate` (Suno, unofficial) |
| sfx | **fal `fal-ai/mmaudio-v2`** (from the picture); ElevenLabs `eleven_text_to_sound_v3` (from words, ≤ 30 s); Stability `stable-audio-2.5` (from words) |
| upscale | **fal `topaz/upscale/video/precision`**; fal `fal-ai/seedvr/upscale/video`; Replicate `topazlabs/video-upscale`; kie.ai `topaz/video-upscale` |
| slowmo | **fal `fal-ai/rife/video`**; fal `fal-ai/film/video` |
| img2video | **fal `fal-ai/kling-video/v2.5-turbo/pro/image-to-video`**; Replicate `kwaivgi/kling-v2.6`; kie.ai `kling-2.6/image-to-video` |
| bg-cut | **fal `fal-ai/birefnet/v2/video`** (a mask); Replicate `bria/video-remove-background` (a cut-out with alpha) |
| vision | **OpenRouter `google/gemini-3.8-flash`**; any OpenRouter model by name; your own server (from still frames) |
| llm | any OpenRouter, Together or own-server model by name |

The sharpen default moved from `fal-ai/topaz/upscale/video` (no longer in fal's catalogue search) to
`topaz/upscale/video/precision` with the same inputs (Proteus, `upscale_factor`, `H264_output`). Checked on
`GET https://api.fal.ai/v1/models?q=topaz` on 2026-11-17. Clips sharpened before keep their cache.

**Per project** (`<data>/workflow.json`): `{"version": 1, "template": null, "blocks": {"voice": {"on": true,
"provider": "elevenlabs", "model": "eleven_v3", "voice": "<id>"}}, "prices": {"kie:topaz/video-upscale": {"usd": 0.05,
"unit": "seconds", "at": "2026-11-17"}}}`. No file, or no block for a capability: the registry's default, exactly as
before. A block naming a model the registry no longer lists falls back to the default with a `warning`.

**Price chain** (every paid call still goes through `charge()`: priced first, refused over the per-reel, total and
daily limits, reserved, settled):

1. the provider's price API: fal `GET /v1/models/pricing` (cached 24 h); OpenRouter `/api/v1/models` for the reviewer;
2. else the registry's list price, with its `source` and `asOf`, and a `warning` when it is over 90 days old;
3. else a price you entered (`POST /api/ai/price`);
4. else the call is refused: 409 `no_price` ("No price is known for … Enter its price in Settings › AI").

The actual cost replaces the estimate when the provider reports it: OpenRouter's `usage.cost`, kie.ai's
`creditsConsumed` (× $0.005 a credit), ElevenLabs' `character-cost` header (× the list price).

**Calls.** A submit waits at most 60 s and is sent once: a 429 or 503 is asked again after `Retry-After` (up to 3
times), but a submit that timed out is never sent again, since it may have been accepted and billed (the estimate stays
in the ledger). Status checks wait 3 s, growing by half each time to 15 s, until the capability's deadline (voice 10
min, music 15, upscale 30, others 20). No webhooks: the studio listens on 127.0.0.1 only. Outputs are downloaded at once
(Replicate deletes them after an hour). kie.ai answers HTTP 200 with its error code in the body (`{"code": 402, "msg":
…}`): the body is read, so that is "out of credit", not a success.

**Outputs are made alike** (`py/studio/providers/normalise.py`): voice → mp3, mono, 44.1 kHz; music → wav, trimmed to
length; sfx → m4a; upscale → H.264 with the clip's own sound put back; img2video → a 9:16 mp4; bg-cut → VP9 with alpha
over the rendered shot. A model marked `conforms` already gives that shape and is used as it is.

### GET /api/ai/providers (free)

Everything the Settings › AI card needs. Never a key: only `hasKey`.

```json
{ "asOf": "2026-11-17", "staleDays": 90, "units": ["seconds", "compute seconds", "minutes", "1000 characters", "…"],
  "capabilities": { "voice": { "labelRequired": true, "what": "a voice reads the reel's approved words", "output": "mp3, mono, 44.1 kHz",
                               "deadline": 600, "tools": ["voice"],
                               "block": { "capability": "voice", "on": true, "provider": "fal", "model": "fal-ai/minimax/speech-02-hd",
                                          "voice": "Japanese_CalmLady", "source": "default" } }, "…": {} },
  "providers": [ { "id": "elevenlabs", "name": "ElevenLabs", "protocol": "sync_http", "keyEnv": "ELEVENLABS_API_KEY", "hasKey": false,
                   "keyHint": "elevenlabs.io/app/settings/api-keys", "dashboard": "https://elevenlabs.io/app/subscription", "core": false,
                   "free": false, "terms": "Commercial use of the output needs a paid ElevenLabs plan …", "freeModels": [], "voices": true,
                   "models": [ { "id": "eleven_v3", "capability": "voice", "label": "Eleven v3 (most expressive; Japanese)", "default": false,
                                 "licence": "commercial", "risk": null, "voiceRequired": true, "maxChars": 5000,
                                 "price": { "usd": 0.08, "unit": "1000 characters", "source": "elevenlabs.io/pricing/api 2026-11-17",
                                            "asOf": "2026-11-17", "stale": false } } ] } ],
  "prices": {}, "workflow": { "exists": false, "template": null } }
```

A model's `price` is `{"usd": null, "code": "no_price"}` when nothing in the chain knows it (the card should ask for one).

### POST /api/ai/select

`{ "capability": "voice", "provider": "elevenlabs", "model": "eleven_v3", "voice": "<voice id>" }` → `{ "capability",
"block", "warnings": [] }`, saved in `<data>/workflow.json`. `{ "capability": "voice", "reset": true }` goes back to the
default; `{ "capability": "voice", "on": false }` switches it off (its tool then answers 409 `off`). Refusals: 400
`bad_input` (unknown provider or model, a model of another capability, anything text-to-video), 400 `no_voice` (a voice
model with no default voice and none given; list them with `GET /api/ai/voices`), 409 `licence` (the provider's own model
page says non-commercial: Replicate's `license_url`, fal's catalogue `license_type`), 409 `risk` (send `acceptRisk: true`).
Warnings: no key yet, no price known, the licence could not be checked live.

### POST /api/ai/price

`{ "provider": "kie", "model": "topaz/video-upscale", "usd": 0.05, "unit": "seconds" }` → `{ "provider", "model",
"removed": false, "price": {…the chain's answer now…} }`. `"usd": null` removes it. `unit` is one of `units`.

### GET /api/ai/voices?provider=elevenlabs&search=…&next=…

`{ "provider": "elevenlabs", "voices": [{ "id", "name", "labels": {"language": "ja", …}, "preview" }], "next": "<token>" }`
from ElevenLabs `GET /v2/voices` with the saved key (400 `no_key` without one).

## POST /api/ai/estimate (free)

Request: `{ "slug": "day-1108", "tools": ["voice", "music"], "options": { "into": "day-1108-ai", "shots": { "living": [2] }, "max_living": 1 } }`.
`options` is optional. `shots.<tool>`: shot indices (from 0) for `sharpen`, `slowmo`, `living`.

```json
{
  "slug": "day-1108", "into": "day-1108-ai",
  "tools": [
    { "tool": "voice", "provider": "fal", "model": "fal-ai/minimax/speech-02-hd", "usd": 0.0061, "labelRequired": true,
      "what": "a Japanese AI voice reads the reel's approved words", "note": null,
      "items": [ { "tool": "voice", "provider": "fal", "model": "fal-ai/minimax/speech-02-hd", "label_required": true, "target": null,
                   "quantity": 0.061, "unit": "1000 characters", "unitPrice": 0.1, "usd": 0.0061, "cached": false,
                   "what": "4 approved lines read aloud (61 characters)", "priceSource": "fal pricing API" } ] },
    { "tool": "music", "usd": 0.2, "items": [ { "what": "an instrumental bed of 26 s (ambient cinematic, 144 BPM)", "usd": 0.2 } ], "…": "…" }
  ],
  "total": 0.2061,
  "caps": { "reel": 2.0, "total": 20.0, "daily": 2.0 },
  "spent": { "reel": 0.0, "total": 0.0077, "today": 0.0077 },
  "room": { "reel": 2.0, "total": 19.9923, "today": 1.9923 },
  "fits": true, "refusal": null, "labelRequired": true,
  "summary": "2 AI steps for day-1108-ai: $0.206. Fits the limits."
}
```

- A tool with nothing to do on this reel has `items: []`, `usd: 0` and a `note`.
- `items[].cached: true` costs 0 (the clip was made before).
- `fits: false` with `refusal` (a sentence) when over a limit, or when tools would change an approved reel without `into`.

## POST /api/ai/run (a background job)

Request: as estimate, plus `"render": true` to queue a render of the changed reel when the tools finish.

1. The server prices it first; over a limit → **402** `{ "error": "<refusal>", "code": "cap", "estimate": {…} }`, nothing spent.
2. Otherwise **200** `{ "job": <job view>, "estimate": {…} }`. The job's `slug` is `ai-<reel>` (e.g. `ai-day-1108-ai`),
   `kind: "ai"`; it reports through `/api/events` and `GET /api/job?slug=ai-day-1108-ai` like a render: `stage/stages`
   (one stage per tool), `done/of` inside a tool, `label`. AI jobs run beside the render queue (network, not CPU);
   they cannot be cancelled.
3. With `options.into` the reel is copied first (`ai_of` names the original; the same moment of every clip is kept), and
   the original is not touched.
4. When it ends: `status: "done"` and `result`:

```json
{
  "slug": "day-1108-ai", "from": "day-1108",
  "applied": [ { "tool": "voice", "usd": 0.0061, "items": 1 }, { "tool": "music", "usd": 0.2, "items": 1 } ],
  "notes": [ { "tool": "voice", "model": "fal-ai/minimax/speech-02-hd", "usd": 0.0061,
               "what": "4 approved lines read aloud (61 characters) in the voice Japanese_CalmLady", "label_required": true } ],
  "spent": 0.2061, "aiLabel": true, "labelNote": "This reel has AI-made content …",
  "ledger": { "reel": 0.2061, "total": 0.21, "today": 0.21 }, "caps": { "reel": 2.0, "total": 20.0, "daily": 2.0 },
  "summary": "2 AI steps on day-1108-ai for $0.206. Render it to hear and see them."
}
```

   or `status: "error"` with the sentence in `label` and `lines`. Tools that finished before an error are kept.
   With `render: true` the label ends "Rendering it now." and the reel's own render job appears in the queue.

What a run writes into the project JSON (`projects/<slug>.json`):

- `shots[i].ai_clip`: `{ tool, file, model, start, speed }`. The renderer grades `file` from `start` at `speed` in place
  of the source window (slow motion: `speed 0.5`; living photo: `start 0.2, speed 1.5`). The location and source gates
  still judge the original footage. A missing file stops the render with a sentence.
- `music`: `{ "id": "ai_day-1108-ai_….wav", "start": 0, "volume": 1 }`. The file is in `<data>/audio/music` with a sidecar
  (`license: "AI-GENERATED"`, `ai: true`, `licenceNote`); it is used only by the reel that names it, never auto-picked.
  `credits.txt` and the YouTube description say "AI-generated music", never CC0.
- `voice`: `{ model, voiceId, gain, lines: [{ file, at, tempo, seconds, text }] }`. Mixed over the music; the music dips
  deeper under the voice and the clip sound dips under it. A line longer than its caption is sped up (at most x1.35).
  The `*_no-music.mp4` copies for Instagram and TikTok have no voice either.
- `ai`: the notes, `[{ at, tool, model, usd, what, label_required }]` (music also has `licence`).
- A reel without any of these renders exactly as before (same filter graphs, same shot keys).

## Reviews

**POST /api/ai/review** `{ "slug": "day-1108", "fresh": false }`: runs the reviewer (≈ 15 s; server timeout 300 s).
The same render is answered from the cache, free (`cached: true`); `fresh: true` pays again.

```json
{
  "slug": "day-1108", "model": "google/gemini-3.8-flash", "usd": 0.0077, "at": "2026-11-09T08:46:38", "stamp": "35181025-1794153740",
  "hook": { "score": 5, "notes": "Opens abruptly on food prep before cutting to parked vans, offering mild visual interest." },
  "look": { "score": 6, "notes": "Natural ambient audio and warm grading, though some interior shots are slightly underexposed." },
  "mismatches": [ { "line": "共用キッチンで、\n自分で作って。", "at": 11.5, "shows": "a person pitching a tent outside",
                    "why": "the caption discusses cooking in the shared kitchen while visuals show outdoor tent setup" } ],
  "claims": [],
  "fixes": [ { "action": "swap clip", "detail": "Swap the tent setup clip at 11.5s with the kitchen cooking clip at 16.5s to align with the captions." } ],
  "summary": "The visuals and captions for the kitchen and deck scenes are inverted and need reordering.",
  "guard": [],
  "cached": false,
  "note": "Suggestions for a person; nothing is changed. The fact guard rows are the studio's own check of the words."
}
```

- Scores are 0-10 (`null` if the model gave none). `mismatches[].at` is seconds into the reel. `fixes` has 1-3 rows.
- `claims`: on-screen claims the model found outside the approved facts (the studio's `approved_facts()` and spec
  banned phrases are sent with the video). `guard`: the studio's own fact guard run on every caption
  (`{text, problem}`, e.g. `price`, `banned:…`): deterministic, show it as a warning.
- Unless the reel is approved, a note is added to the project's `ai` list.
- `basis`: `"video"` (OpenRouter watched the reel with its sound) or `"frames"` (your own vision model read still
  frames). `partial`: `false` for a video review, `true` for a frames review. An older review file has neither field:
  read it as `"video"`.

**From still frames (your own vision model).** When `STUDIO_LLM_VISION_MODEL` is set (`config.own_llm`) and there is no
OpenRouter key, or `STUDIO_AI_REVIEW_LOCAL=1` is in `.env`, the reviewer does not send the video. It grabs 12 to 16
frames of the master (`frame_times`: the opening at 0.3 s, the middle of every shot, evenly spaced moments), 540 px
tall, puts them four to a JPEG contact sheet labelled `#frame time shot`, and sends the sheets with the same data
(captions with times, shots with times, approved facts, banned phrases, rules) plus `frames: [{frame, at, shot}]`
through `vision_json`. It is free (nothing in `spend`). The brief tells the model it has no sound and no motion. The
result has the same shape, plus:

```json
{ "model": "qwen3-vl:8b", "usd": 0, "basis": "frames", "partial": true, "frames": 13, "server": "http://127.0.0.1:11434/v1",
  "hook": { "score": 6, "notes": "From still frames: …" }, "look": { "score": 7, "notes": "From still frames (no sound or motion judged): …" } }
```

- The cache is per render, model and basis, so a frames review is never returned as a video review, and the other
  way round. Add a key (without `STUDIO_AI_REVIEW_LOCAL`) and the next review watches the video.
- `GET /api/ai` has `reviewBasis`: `"video"`, `"frames"` or `null` (no reviewer). The estimate's `review` row then
  has `provider: "own"`, the vision model, `unit: "frames"` and `usd: 0`.
- A frames review cannot hear the audio or see the motion, so its look score is not the same measure as a video
  review's. Compare two reviews only when they have the same `basis`.

**GET /api/ai/review?slug=day-1108** (free): `{ "slug": "day-1108", "review": <the last review> | null }`, with
`review.current: false` when the reel was rendered again since.

## /api/reel additions

`ai` (the notes), `aiLabel` (true when a note has `label_required`), `aiLabelNote` (the sentence to show, or `null`),
`aiOf` (the original's slug for an AI copy, else `null`).

## POST /api/settings: AI keys and limits

Request (any of): `{ "fal_key": "…", "openrouter_key": "sk-or-…", "together_key": "…", "keys": { "elevenlabs": "sk_…" },
"ai_reel_cap_usd": 2, "ai_total_cap_usd": 20 }`. `keys` takes any provider in `GET /api/ai/providers` (`elevenlabs`,
`stability`, `replicate`, `kie`, and the three above).
May be combined with `firecrawl_key` and `tz` (then the tz flow runs as before). No restart: the AI tools read `.env` on every call.

1. Each key is checked with the provider's free call, the registry's `check` (fal: the pricing API; OpenRouter:
   `GET /api/v1/key`; Together: `GET /v1/models`; ElevenLabs: `GET /v1/models`; Stability: `GET /v1/user/account`;
   Replicate: `GET /v1/account`; kie.ai: `GET /api/v1/chat/credit`, whose body code is read too). A wrong key → 400 `bad_key` with the sentence, and `.env` is not touched.
2. It is upserted into the studio's `.env` (git-ignored) under the name the tools read:
   `fal_key` → `FAL_KEY`, `together_key` → `TOGETHER_API_KEY`, `openrouter_key` → **`OPENROUTER_API_KEY_PARKED`**;
   `keys.<provider>` → that provider's `keyEnv` (`ELEVENLABS_API_KEY`, `STABILITY_API_KEY`, `REPLICATE_API_TOKEN`,
   `KIE_API_KEY`). Every `keyEnv` must match `^[A-Z][A-Z0-9_]{2,40}_(KEY|TOKEN)$`, so a key can only land on such a line.
3. `""` removes the key. The value is never returned, logged or put in an error.

```json
{ "ok": true, "ai": { "saved": { "fal_key": { "saved": true, "removed": false }, "caps": { "ai_reel_cap_usd": 2.0 } },
                      "keys": { "fal": true, "openrouter": true, "together": true }, "caps": { "reel": 2.0, "total": 20.0, "daily": 2.0 } } }
```

`keys` in the answer (and in `GET /api/ai`) always has fal, OpenRouter and Together, plus any other provider whose key is
saved; `GET /api/ai/providers` lists them all.

Errors: 400 `bad_key` ("That does not look like a OpenRouter key. Copy it again from openrouter.ai/settings/keys (they
start with sk-or-)." or "fal.ai did not accept the key. …"), 400 `bad_input` ("ai_total_cap_usd: a number of US dollars
from 0 to 1000."). Keys saved before the failing field stay saved (`saved` lists them).

**Why the parked name.** The old paid tagging reads `OPENROUTER_API_KEY`. Saving the reviewer's key under
`OPENROUTER_API_KEY_PARKED` keeps tagging off. The owner turns tagging on with the separate switch
`STUDIO_PAID_TAGGING=on` in `.env` (then `studio.config.openrouter_key()` uses the parked key too), or by setting
`OPENROUTER_API_KEY` itself. `GET /api/ai` → `paidTagging` says which is the case.

## MCP

`server/mcp.mjs`: `ai_estimate` (read-only, spends nothing), `ai_review` (suggestions only; `last_only: true` never
spends), `ai_run` (prices first and refuses over a limit or over its own `max_usd`, nothing spent; `into` for a copy;
renders when done). See `docs/mcp.md`.
