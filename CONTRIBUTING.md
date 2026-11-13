# Contributing

Thank you for helping. Small, focused changes are easiest to review.

## Before you start

- For a bug, open an issue with the steps first (Issues › New › Bug report). For a security problem, read [SECURITY.md](SECURITY.md) instead.
- For a new feature, open an issue and say what it is for before writing much code. The studio stays simple on purpose.
- By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Rules the code keeps

- **A person approves every post.** No change may post, book or upload a reel whose review status is not "approved". No agent, script or timer may approve.
- **Everything stays local.** Nothing leaves the computer unless the person connected that service. Keys are never logged, printed or committed.
- **Paid AI is optional and capped.** Price a call before making it; refuse it over the limits (`docs/ai-api.md`).
- **The studio never writes a claim.** On-screen words come from approved lines (`py/studio/wording.py`), and the fact guard checks them.
- **No owner's data in the code.** Use placeholders (`example.com`, `@example_owner`, made-up brands like Cafe Kumo) in tests and docs.

## Set up

You need Node 20+, Python 3.12+ and a current ffmpeg (see the README).

```
npm ci
npm run setup
```

## Check your change

```
npm test                         # layout, copy, server, helper and docs tests
npm run typecheck                # types (tsc --noEmit -p .); it passes with no errors
cd py && python -m pytest -q     # the Python pipeline; set STUDIO_TOOLS to your ffmpeg folder
```

The Python tests use a throwaway data folder and the built-in reference workspace. Tests marked `ranch` need the original workspace's own files and are skipped, with the reason, in a plain clone.

CI runs the same on Ubuntu (`.github/workflows/ci.yml`). Add or change tests with your change; do not delete or loosen a test to make it pass.

## Change the docs with the code

`npm test` checks part of the docs against the code. It fails when they drift:

| Test | Checks |
|:--|:--|
| `test/openapi-routes.test.mjs` | Every route in `server/review.mjs` is in `docs/openapi.yaml`, and back |
| `test/env-example.test.mjs` | Every environment variable the code reads is in `.env.example` |

- A new route goes into `docs/openapi.yaml` in the same change.
- A new environment variable goes into `.env.example`, with a one-line comment.
- A change a person sees (a page, a button, a command) goes into `docs/user-guide.md`, and into `CHANGELOG.md` under the unreleased version.
- Screenshots live in `docs/img/`. Take them at 1280 px wide. Never show a face close up, an e-mail address, a key or a token.

## Commits and pull requests

- One topic per pull request. Say what changed and how you checked it.
- Commit messages: `type(scope): what changed` (`feat`, `fix`, `docs`, `test`, `chore`, `ci`), in plain words.
- Write the way the README does: short sentences, plain words, no marketing.

## Licence

The project is under the [Apache License 2.0](LICENSE). By sending a pull request you agree that your contribution is licensed the same way (section 5 of the licence). The names "Lazycow" and "Lazycow Studio" and the icon are not covered: see [TRADEMARKS.md](TRADEMARKS.md).
