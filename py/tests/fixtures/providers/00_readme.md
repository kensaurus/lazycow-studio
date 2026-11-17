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
