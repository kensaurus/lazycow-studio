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
| `refused` | 422 | Runway refused this request on content or safety grounds: The image did not pass moderation. Another service is not asked in its place; change the input instead. |
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
| `fal_queue` | submit, poll `status_url`, read `response_url` | fal.ai |
| `async_task` | submit a task, poll it, read the output; every path and state name comes from the registry's `task` block | Replicate, kie.ai, Runway, MiniMax video, Together video, OpenRouter video, Higgsfield, PiAPI, Luma |
| `sync_http` | one request; the answer is the file, or JSON with the file's URL (`result`); with `poll` an HTTP 202 and an id first, then the file from `poll.path` (Stable Audio 3.0) | ElevenLabs, Stability AI, MiniMax speech, OpenRouter speech |
| `openai_chat` | `POST <base>/chat/completions`, or the model's own `path` (kie.ai: one address per model) | OpenRouter, Together, Gemini (its OpenAI-compatible endpoint), kie.ai (Gemini 3.8 Flash), your own model server |

No new adapter was needed for phase 2: a model may name its own `protocol` (OpenRouter's chat is `openai_chat`, its
`/videos` and `/audio/speech` models are `async_task` and `sync_http`), a provider may send fixed headers on every call
(`headers`: Runway's `X-Runway-Version: 2024-11-06`), and `upload` says how a still reaches the model: `multipart`
(Replicate, kie.ai), `data_uri` inline (Runway ≤ 5 MB, MiniMax, OpenRouter), bare `base64` (Together's
`frame_images`, Luma's `start_frame.data`), `json_base64` (PiAPI's ephemeral upload) or `presigned` (Higgsfield: ask
for an upload URL, PUT the bytes there with the headers it gives, never the key). States are compared without case
(PiAPI answers `Completed`). `outputAuth` downloads a result with the key (OpenRouter's `unsigned_urls`).

**Capabilities are a closed list:** `voice`, `music`, `sfx`, `upscale`, `slowmo`, `img2video`, `bg-cut`, `llm`,
`vision` (the tools map onto them: `sharpen` → upscale, `living` → img2video, `foley` → sfx, `behind` → bg-cut,
`review` → vision). Text-to-video can never be registered: the registry refuses a capability, model, path or input
that names it, and **every img2video model must take the still** (`files: {…: "image"}`), so a prompt-only mode is
unreachable. `labelRequired` belongs to the capability (`voice` and `img2video`), never to a provider, so a reel is
labelled the same whoever made the voice. A model without a commercial licence is refused; kie.ai's Suno music and
PiAPI's Kling (run on PiAPI's own pool of consumer accounts) are marked `"risk": "unofficial"`, are never a default, and
can only be picked with `acceptRisk: true`. Every provider names the official pages its entry was checked against
(`docs`) and the day (`asOf`); placeholders are lowercase (`{image_url}`), or the validator refuses the file.

What is registered (2026-11-18; **bold** = the default, exactly the tools before the registry):

| capability | models |
| --- | --- |
| voice | **fal `fal-ai/minimax/speech-02-hd`**; fal `fal-ai/elevenlabs/tts/eleven-v3`; ElevenLabs `eleven_v3`, `eleven_multilingual_v2`, `eleven_flash_v2_5`; Replicate `minimax/speech-2.8-turbo`; kie.ai `elevenlabs/text-to-speech-turbo-2-5`, `elevenlabs/text-to-speech-multilingual-v2`; MiniMax `speech-2.8-hd`, `speech-2.8-turbo` (direct, `Japanese_CalmLady`); OpenRouter `elevenlabs/eleven-v3` (preset voices only) |
| music | **fal `fal-ai/stable-audio-25/text-to-audio`**; Stability `stable-audio-2.5`, `stable-audio-3` (≤ 380 s, 8 credits); Replicate `stability-ai/stable-audio-2.5`; ElevenLabs `music_v2_5` (`force_instrumental`); kie.ai `ai-music-api/generate` (Suno, unofficial) |
| sfx | **fal `fal-ai/mmaudio-v2`** (from the picture); ElevenLabs `eleven_text_to_sound_v3` (from words, ≤ 30 s); Stability `stable-audio-2.5`, `stable-audio-3` (from words) |
| upscale | **fal `topaz/upscale/video/precision`**; fal `fal-ai/seedvr/upscale/video`; Replicate `topazlabs/video-upscale`; kie.ai `topaz/video-upscale` |
| slowmo | **fal `fal-ai/rife/video`**; fal `fal-ai/film/video` |
| img2video | **fal `fal-ai/kling-video/v2.5-turbo/pro/image-to-video`**; Replicate `kwaivgi/kling-v2.6`; kie.ai `kling-2.6/image-to-video`; Runway `gen4_turbo` ($0.05/s), `gen4.5` ($0.12/s); MiniMax `MiniMax-H3` ($0.08/s), `MiniMax-H3-Highspeed` ($0.06/s); Together `Wan-AI/wan2.7-i2v`; OpenRouter `kwaivgi/kling-v3.0-std` ($0.084/s, its `usage.cost` recorded); Higgsfield `kling-video/v2.5-turbo/standard/image-to-video`; Luma `ray-3.2` (no list price: enter yours); PiAPI `kling-2.5-std` (unofficial) |
| bg-cut | **fal `fal-ai/birefnet/v2/video`** (a mask); Replicate `bria/video-remove-background` (a cut-out with alpha) |
| vision | **OpenRouter `google/gemini-3.8-flash`**; any OpenRouter model by name; Together `moonshotai/Kimi-K3`, Gemini `gemini-3.8-flash` and kie.ai `gemini-3-8-flash:vision` (still pictures only: picture questions go there when the project picks them; the reviewer keeps watching video on OpenRouter); your own server (from still frames) |
| llm | Together `zai-org/GLM-5.3-Flash` (MIT; gpt-oss-120b left Together's serverless list); Gemini `gemini-3.8-flash` (list price until 2026-12-31, then a warning); kie.ai `gemini-3-8-flash` (its full price kept; the actual cost is its `credits_consumed`); any OpenRouter, Together, Gemini or own-server model by name. With no pick: OpenRouter with `shared/spec.json` `openrouter.edlModel` |

**Writing help (`research._llm`: post angles, word ideas) goes through the registry.** It asks the project's `llm`
block (else OpenRouter with the studio's writing model), prices the question from the registry (`chat_price`: the
model's list price, else OpenRouter's own price list for a model asked for by name; nothing known: not asked, the
templates answer), and runs inside `charge()` with no slug: the daily budget and the AI total hold, the per-reel limit
does not, and the ledger row keeps its purpose (`research`, `words-suggest`) and now its provider. A provider's
`chat` options are data: OpenRouter `{"jsonMode": true, "extra": {"reasoning": {"effort": "low"}}}`, Gemini
`{"jsonMode": false, "extra": {"reasoning_effort": "low"}}`, Together `{"jsonMode": false}` (the answer's JSON is read
from the text, fenced or wrapped), kie.ai `{"jsonMode": false, "bodyCode": "code", "okCodes": [200], "bodyMessage":
"msg", "cost": "credits_consumed", "costUnit": "credits"}`: kie.ai answers an error as HTTP 200 with `{"code": 402,
…}`, read into the shared vocabulary (through `errorKinds`), so an empty kie.ai account hands the question to a backup. Your own model server still answers instead when it is set and the project picked
nothing else.

**Looked at and left out** (registry `_rejected`, read 2026-11-18): MiniMax music (its paid Music API closed to new users
on 2026-08-20); Gemini video (Veo 3.1 Preview shut down 2026-10-22; Omni Flash video is not on the OpenAI-compatible
endpoint); PiAPI music (Suno sunset; Udio on a consumer-account pool, no licence); Together video understanding
(dedicated endpoints only); Stability image-to-video (its API has none); Veo and Omni Flash through OpenRouter (image-
conditioned, but their licence passes through OpenRouter unverified here). Added 2026-11-26: image generation on
Stability, Together and kie.ai (a reel has no image step, and a made-up picture is a scene the studio never invents);
kie.ai sound effects (no ElevenLabs sound model there now; only Suno's, unofficial); kie.ai cut-out and slow motion
(image-only, none); kie.ai's own `video/upscale` (no price on kie.ai/pricing).

Sources (official, read 2026-11-18): docs.dev.runwayml.com/api and /guides/pricing, dev.runway.com/learn/commercial-use;
platform.minimax.io/docs/api-reference/video-generation-v2-create, -v2-query, speech-t2a-http, /docs/pricing/overview,
/docs/guides/music-generation, /protocol/terms-of-service; docs.together.ai/reference/create-videos,
/docs/inference/videos/reference-and-keyframes, /docs/inference/vision/overview, /docs/serverless-models,
together.ai/models/wan-27-i2v; openrouter.ai/docs (video image-to-video cookbook, submit-a-video-generation-request,
tts create-speech), openrouter.ai/api/v1/videos/models; docs.higgsfield.ai/docs/concepts/requests and /file-uploads,
higgsfield.ai/higgsfield-api, Higgsfield Terms §4.4; ai.google.dev/gemini-api/docs/openai, /pricing, /video;
piapi.ai/docs/kling-api/create-task, /get-task, /overview, /tools/file-upload, /sunsetting-suno;
docs.agents.lumalabs.ai/guides/videos/generation, /pricing, /usage, lumalabs.ai/legal/api-terms-of-use;
elevenlabs.io/docs/api-reference/music/compose, elevenlabs.io/pricing/api; docs.stability.ai/llms.txt.

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
2. else the registry's list price, with its `source` and `asOf`, and a `warning` when it is over 90 days old or past
   its `validUntil` (a price the provider said would change on a known day);
3. else a price you entered (`POST /api/ai/price`);
4. else the call is refused: 409 `no_price` ("No price is known for … Enter its price in Settings › AI").

The actual cost replaces the estimate when the provider reports it: OpenRouter's `usage.cost` (chat and video),
kie.ai's `creditsConsumed` (tasks) and `credits_consumed` (chat), × $0.005 a credit, ElevenLabs' `character-cost` header and MiniMax's
`extra_info.usage_characters` (× the list price). MiniMax speech answers HTTP 200 with its error in
`base_resp.status_code` (like kie.ai): read, so 1008 is "out of credit". Keys: `RUNWAY_API_KEY`, `MINIMAX_API_KEY`,
`HIGGSFIELD_API_KEY` (`<key id>:<key secret>` as one value), `GEMINI_API_KEY`, `PIAPI_API_KEY`, `LUMA_AGENTS_API_KEY`,
each checked with a free call before it is saved (Higgsfield has none: an unknown request's status answers 404 to a
good key, 401 to a bad one). Runway and Luma report their credit balance.

`price.minQuantity` is the least one call is billed, in the price's unit: kie.ai bills each ElevenLabs line as at
least 1000 characters (a 10-character line cost 6 credits, live check 2026-11-26), so the estimate, a backup's reprice
and the Workflow page's cost per reel count each line as at least one unit (`measure.lineChars`). Every request sends
`User-Agent: LazycowStudio/1.0` unless its caller names one: Together's Cloudflare refuses urllib's own with HTTP 403
"error code: 1010" before the key is read, which was taken for a refused key.

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
from ElevenLabs `GET /v2/voices` with the saved key (400 `no_key` without one). A provider whose docs give a fixed
list (registry `voices.fixed`: kie.ai's 20 ElevenLabs voice ids) answers from the registry with no call and no key, and
`POST /api/ai/select` refuses a voice not on that list (400 `bad_input`).

## When a service runs out: automatic switch to a backup (py/studio/fallback.py)

The owner (18 Nov): "if I run out of fal.ai auto switch to others for all workflow in the block".

**One error vocabulary.** Every adapter's failure carries `kind` (`studio.providers.http.KINDS`), whoever answered:

| kind | What it reads | Switches? |
| --- | --- | --- |
| `out_of_credit` | 402; balance, credits or quota words (fal "Exhausted balance", OpenRouter "Insufficient credits", Runway "not enough credits", ElevenLabs `quota_exceeded`, Gemini "exceeded your current quota … billing"); kie.ai `code 402` and MiniMax `1008` inside an HTTP 200 | yes; the service is marked out for 6 h |
| `auth` | a missing, refused or expired key (401/403, Google's "API key not valid", MiniMax `1004`) | yes; marked out until the key changes (a key never saved is not marked) |
| `rate_limited` | 429 after the existing retries (a per-minute quota is a wait, not an empty account) | yes; 10 min |
| `unavailable` | 5xx, a timeout, no connection | yes; 10 min |
| `refused` | a content or safety refusal (Higgsfield `nsfw`, Runway `SAFETY.*`, Replicate "flagged", MiniMax `1026`/`1027`, OpenRouter's moderation 403) | **never**: another service must not be used to get round a refusal |
| `bad_input` | anything else the provider could not use | never |

A provider's own codes are read through its registry `errorKinds` (exact, or a prefix ending in `*`) and, for a failed
task, `task.errorCode` (where the code is). A failure the provider may have billed (a submit that timed out) is never
switched: one result is never paid for twice.

**The backup list per capability**, asked in order after the block's own choice:
1. your list in `workflow.json`: `"fallback": {"img2video": [{"provider": "runway", "model": "gen4_turbo"}, …]}` (a
   `voice` may be given per entry; an unofficial model needs `acceptRisk: true`), else
2. the automatic list: every other service that does the capability, has a key and a price and is not unofficial; the
   registry's default first, then the cheapest for one typical reel. The first choice's own service is left out (it is
   out with it); Luma without a price, unofficial routes and voice models that need a voice picked are passed over.

Every attempt goes through `ai.charge()`'s caps again (per reel, the AI total, the daily budget) at that service's own
price; a backup over a cap is passed over and the next one asked. A backup dearer than `maxRise` × the first choice's
estimate (default 2×) is passed over, and the reason is part of the error if nothing worked. The ledger row of the
attempt that worked names the provider used, with `fell_back_from` and `fallback_reason`; the failed attempt's row is
$0 (`failed: no_credits`). The reel's AI note says "(made by Runway: fal.ai could not)", and music credits name the
service that really made it. Covered: every generating tool (voice, music, natural sound, sharpen, slow motion, moving
photo, cut-out, long-video music), picture questions (`vision_json`) and writing help (`research._llm`). The video
reviewer has no backup (only OpenRouter takes video) but still marks OpenRouter out for the others.

**Switches** (`workflow.json` `autoSwitch`): `on` (the master switch, default on), `maxRise` (1-10, default 2) and
`caps` per capability. **Voice is off by default** (another service reads in another voice); every other capability is on.

**"Out" memory**: `<data>/ai-health.json` (written to a temporary file and moved, so it is never half-read):
`{providers: {fal: {kind, at, until, message, keyTag?}}, switches: [the last 200]}`. A mark is per service, so every
block that uses it goes straight to its backup (the first choice is still asked last, in case it was topped up). When the
cooldown ends the next call asks the first choice first again. `keyTag` is a hash of the key, never the key.

### GET /api/ai/health (free)

`{settings: {on, maxRise, caps}, capabilities: {cap: {auto, provider, model, source: "yours"|"auto", chain: [{provider,
model, providerName, label, hasKey, perReel, docs, skip, health}], backup, using: {from, kind, provider, since, backup} |
null}}, providers: [{id, name, state, since, until, message, billing, caps}], problems: [{provider, kind, level:
"amber"|"red", caps, noBackup, switched: [{provider, name, n}], billing}]}`. The Needs-you strip turns `problems` into
"fal.ai is out of credit, so 3 jobs used Runway instead" (amber) or "… and no other service is set up for Music,
Voice-over" (red), with **Try fal.ai again** and **Top up** (the registry's `dashboard`).

### POST /api/ai/fallback

Any of `{on}`, `{maxRise}`, `{capability, auto}`, `{capability, chain: [...] | null}` (null: back to the automatic
list). Answers with the health view plus `saved` and `warnings` (e.g. a backup with no key yet).

### POST /api/ai/health/reset

`{provider}` or `{all: true}`: forget the mark ("Try X again"). Answers with the health view.

### POST /api/ai/health/mark

`{provider}`: "It's out of credit", said by hand. Some keys cannot read their balance (fal without billing access), so
the studio would only learn a service is empty when a paid step fails; this marks it out for the same 6 h. Settings ›
AI blocks then opens with that service's jobs and a one-click switch to the first backup with a saved key (the jobs
no saved-key service can do are named; their Change picks one, and a service without a key says "Add your key").
Answers with the health view.

Templates in `shared/workflows/` may carry `"fallback": {cap: [{provider, model}]}` (never an unofficial model); Apply
writes those lists and Undo puts the old file back (*Pro polish* and *Low-cost cloud* do). Tests:
`py/tests/test_fallback.py`, with error fixtures in `py/tests/fixtures/providers/errors/` (modelled on each provider's
documented error shape, not captured from a live failure).

## The workflow: blocks, templates, undo, this month's spend (py/studio/workflow.py)

Settings › Workflow and Settings › Keys & AI › AI blocks read one view. Nothing here asks a provider anything: prices
come from the same chain as `/api/ai/providers` (fal's last live table, the registry's list price, a price you entered).

### GET /api/workflow (free)

`{ "capabilities": {cap: block}, "order": [...], "template": "music-first"|null, "perReel": 0.71, "reelSeconds": 15,
"templates": [...], "undo": {"can", "at", "template"}, "ownLlm", "reviewBasis": "video"|"frames"|null, "spend": {…as
/api/ai/spend…}, "units": [...], "rejected": [{"what", "why"}] }`.

A block is the capability **as it really runs**: `{ on, provider, providerName, model, modelLabel, voice, source
("default"|"workflow"|"own"|"key"), local, hasKey, labelRequired, what, perReel: {usd, basis, unit?, unitPrice?,
source?}, choices: [...], tools }`. `llm` and `vision` follow your own model server first (writing help; a review from
still frames), so they say `own` when it is set. `perReel` prices one typical 15 s reel (`TYPICAL`: about 60 characters
read aloud, an 18 s music bed, two silent 2 s shots, three soft 2 s shots sharpened, two shots in slow motion, one photo
moved for 5 s, a 2 s cut-out, one review); a block priced by tokens with no list price uses your average per call from
the ledger, else `usd: null`. Each choice adds `docs` (the provider's first documentation link), `asOf` (when its
registry entry was read), `risk` (e.g. "unofficial": picked only with `acceptRisk: true` on `/api/ai/select`, never a
default, never by a template) and `priceNeeded` (no price anywhere, e.g. Luma: enter one with `/api/ai/price` first).
`rejected` is the registry's `_rejected`: what was looked at and not offered, and why.

A template (`shared/workflows/<id>.json`) is `{ id, order, icon, name: {en, ja}, summary: {en, ja}, who: {en, ja},
blocks: {cap: {on: false} | {provider, model, voice?} | {provider: "@default"} | {provider: "@cheapest"} |
{provider: "own", model: "@own"}} }`. A capability it leaves out is kept. `@cheapest` is the lowest cost per reel among
registered models without a risk mark or a required voice, preferring services whose key is saved (new providers count by
themselves); `@own` is your own model server (off, with a note, when none is set). A template is checked when read
(`check_template`): registered models only, never text-to-video, both languages. In the view each template carries
`diff` ([{capability, before, after, usdBefore, usdAfter}]), `notes`, `missingKeys`, `on`, `perReel` and `perReelNow`.

### POST /api/workflow/apply

`{ "template": "music-first", "confirm": true }` → `{ "applied", "notes", "undo", "view" }`. Without `confirm: true` it
is refused (400 `confirm`): only the page's **Apply** button sends it. `workflow.json` as it was is first copied to
`workflow.prev.json` (or noted as absent); prices you entered stay.

### POST /api/workflow/undo

`{}` → `{ "undone", "undo", "view" }`: the workflow from before the last Apply is back (the file is removed if there
was none), once; 409 `nothing` when there is nothing to undo.

### GET /api/ai/spend?month=YYYY-MM (free)

Paid AI this calendar month (this computer's clock) from the `spend` table: `{ "month", "total", "calls",
"byCapability": [{capability, usd, calls}], "byProvider": [{provider, name, usd, calls}], "rows": [{capability,
provider, usd, calls}], "budget": {daily, month (daily × days), dayOfMonth, days, aiCap, aiSpent, aiLeft} }`. Rows
written by `charge()` (`ai-<tool>`) map to their tool's capability; the tagger (`tagcheck`) counts as vision and word
suggestions as llm. The status bar shows the total as **AI $…**.

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
