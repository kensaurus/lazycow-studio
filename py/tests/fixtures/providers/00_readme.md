# Provider fixtures

Answers recorded in the shapes the providers' own API references document (read 2026-11-17), with every id, URL and
number replaced by a made-up one. `py/tests/test_providers.py` replays them through the same fake HTTP layer as
`test_ai.py`, so no test touches the network or spends anything.

| Folder | Source of the shape |
| --- | --- |
| `fal/` | fal queue API (queue.fal.run submit / status / response) |
| `replicate/` | replicate.com/docs/reference/http (predictions, files, models) |
| `kie/` | docs.kie.ai (jobs/createTask, jobs/recordInfo, chat/credit, file-stream-upload) |
| `elevenlabs/` | elevenlabs.io/docs/api-reference (v2/voices, user/subscription) |
| `stability/` | docs.stability.ai (user/balance) |
| `runway/` | docs.dev.runwayml.com/api (POST /v1/image_to_video, GET /v1/tasks/{id}, GET /v1/organization), read 2026-11-18 |
| `minimax/` | platform.minimax.io/docs/api-reference (v2 video_generation create / query, t2a_v2), read 2026-11-18 |
| `together/` | docs.together.ai/reference/create-videos (VideoJob), read 2026-11-18 |
| `openrouter/` | openrouter.ai/docs/api/api-reference/video-generation (submit, polling, unsigned_urls, usage.cost), read 2026-11-18 |
| `higgsfield/` | docs.higgsfield.ai/docs/concepts/requests and /file-uploads, read 2026-11-18 |
| `piapi/` | piapi.ai/docs/kling-api/create-task, /get-task and /tools/file-upload, read 2026-11-18 |
| `luma/` | docs.agents.lumalabs.ai/guides/videos/generation and /guides/usage, read 2026-11-18 |
| `gemini/` | ai.google.dev/gemini-api/docs/openai (chat completion), read 2026-11-18 |
