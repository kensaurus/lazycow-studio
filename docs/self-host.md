# Run Lazycow Studio on a server (Docker)

For an always-on machine (a home server, a NAS with an x86-64 or ARM64 processor, a VPS) that keeps your footage and
renders reels while you open the studio from a laptop or tablet. On your own computer the double-click setup
(README › Quick start) is simpler and can do more (see [What does not work in a container](#what-does-not-work-in-a-container)).

The image is `ghcr.io/kensaurus/lazycow-studio` (linux/amd64 and linux/arm64), built from [`Dockerfile`](../Dockerfile)
for every release. It holds Node, Python with CPU-only PyTorch, ffmpeg and Remotion's Chrome. It holds no keys:
those come from your `.env` and the `/data` volume.

There is one API token and no user accounts. Whoever has the token can do everything in the studio, so share it only
with people you would hand your computer to.

## Start it

In a folder with [`compose.yaml`](../compose.yaml) (a clone of the repository, or that file alone):

```sh
mkdir lazycow && cd lazycow
curl -fsSLO https://raw.githubusercontent.com/kensaurus/lazycow-studio/main/compose.yaml
echo "STUDIO_API_TOKEN=$(openssl rand -hex 16)" >> .env
echo "LAZYCOW_FOOTAGE=/srv/footage" >> .env      # your footage folder on this server (read only); default ./footage
docker compose up -d
```

Then open `http://127.0.0.1:4317/?token=<your token>` once. The browser keeps the token (a cookie for 30 days; then
open that address again) and drops it from the address. Programs send `Authorization: Bearer <token>` instead.
`GET /api/health` is the only address that answers without it, and then it says only `{"ok":true}` (enough for
Docker's health check). With the token it also shows the version, the build and the machine's processor, memory and
free disk.

A new studio has no themes, so **Make reels** makes nothing until you add one (Reels › Themes), or start from the
example cafe's brand, themes and words: `docker compose exec studio sh -c 'cp -n /app/examples/cafe-kumo/*.json /data/'`.

If you changed the left number of the `ports:` line, add that address to `STUDIO_ALLOWED_HOSTS` (for example
`127.0.0.1:8080`), or every page answers 403; the account sign-ins below still need 4317.

**No token, no studio.** Without `STUDIO_API_TOKEN` (24 characters or more) Compose stops before starting, and the
container on its own exits with code 78 and says so in `docker compose logs`:

```
STUDIO_HOST=0.0.0.0 and STUDIO_ALLOWED_HOSTS=localhost:4317,127.0.0.1:4317 open the studio beyond this computer,
so STUDIO_API_TOKEN must be set to at least 24 random characters (for example: openssl rand -hex 16). Not starting.
```

What goes where:

| In the container | What | Compose |
|:--|:--|:--|
| `/data` | everything the studio makes and keeps: catalog, renders, working files, settings (`/data/.env`), keys, sign-ins, the search model | the `studio-data` volume |
| `/footage` | your footage, only ever read | `LAZYCOW_FOOTAGE`, mounted read-only |

To keep `/data` in a folder instead of a volume, write `- /srv/lazycow:/data` in `compose.yaml` and give it to the
studio's user first: `sudo chown -R 10001:10001 /srv/lazycow`. The footage folder only needs to be readable by
user 10001.

Settings › Keys & AI saves into `/data/.env`. `STUDIO_*` lines in Compose's `environment:` win over it.

## Reach it from another computer

The port is published on `127.0.0.1` only. Pick one way in, and put the name you type in the address bar into
`STUDIO_ALLOWED_HOSTS` in `.env` (comma-separated; `127.0.0.1:4317` and `localhost:4317` always work):

- **SSH tunnel** (nothing to set up): `ssh -L 4317:127.0.0.1:4317 you@your-server`, then open
  `http://127.0.0.1:4317` on your own computer.
- **Tailscale**: `tailscale serve --bg 4317` on the server, then
  `STUDIO_ALLOWED_HOSTS=your-server.your-tailnet.ts.net` and open `https://your-server.your-tailnet.ts.net`.
- **An HTTPS reverse proxy** in front, for example Caddy: `studio.example.com { reverse_proxy 127.0.0.1:4317 }` and
  `STUDIO_ALLOWED_HOSTS=studio.example.com`. The proxy must pass the `Host` header through unchanged and not buffer
  responses (the studio streams progress); with nginx: `proxy_set_header Host $host; proxy_buffering off;
  client_max_body_size 0;`.
- **A proxy that runs in Docker too** (Caddy, Traefik, Nginx Proxy Manager): it cannot reach `127.0.0.1:4317` on the
  host. Put the proxy on the studio's network (`docker network connect lazycow_default <proxy>`, or an `external`
  network in both Compose files) and point it at `studio:4317`, e.g. Caddy: `studio.example.com { reverse_proxy studio:4317 }`.
  Then the `ports:` line can go.
- **Your LAN, plain HTTP**: change the port line to `"4317:4317"` and set
  `STUDIO_ALLOWED_HOSTS=192.168.1.20:4317` (the server's address). The token then crosses your network unencrypted,
  so prefer one of the above. Docker opens published ports past `ufw`/`firewalld`, so on a server with a public
  address this publishes the studio to the internet; keep `127.0.0.1:` there.

The first visit's `/?token=…` address lands in a proxy's access log. Open it once through an SSH tunnel instead, or
turn the log off for that host. Use a random token (`openssl rand -hex 16`), not just a long one. To change it, edit
`.env` and `docker compose up -d`; every browser then asks for the new one.

Run `docker compose up -d` again after changing `.env`. A name that is not listed gets `the studio does not answer to
the name "…": add it to STUDIO_ALLOWED_HOSTS` (403).

The cookie is marked `Secure` when the connection is HTTPS: a TLS connection to the studio itself, or, with
`STUDIO_TRUST_PROXY=1`, a proxy that says `X-Forwarded-Proto: https` (see below). It is always `HttpOnly` (page
scripts cannot read it) and `SameSite=Lax`.

## Wrong tokens

Each wrong token (in the header, the cookie or `/?token=`) is one line in `docker compose logs`. The line never holds
the token, and the path has no query:

```
2026-11-19T01:02:03.000Z lazycow auth failed ip=172.18.0.1 method=GET path=/api/overview
```

The same wrong value from the same address is counted and logged once per window, so a browser that still has an old
token after you changed it makes one line, not one per request. After 10 different wrong tokens from one address in 10
minutes, that address gets 429 with `Retry-After` until 10 minutes after its first failure, even with the right token.
Other addresses are not affected. `/api/health` still answers `{"ok":true}`. A restart clears the count.

The address is the one the connection comes from. By default the studio does not read `X-Forwarded-For`, because any
client can write it. So behind a reverse proxy, or through the `127.0.0.1:` port line (every visitor then comes from
Docker's address, such as `172.18.0.1`), the pause applies to all visitors at once, and someone guessing can pause the
studio for you.

**Behind a proxy, set `STUDIO_TRUST_PROXY=1`** (in `.env`, or under `environment:` in `compose.yaml`). The studio
then reads the visitor's address from `X-Forwarded-For` and HTTPS from `X-Forwarded-Proto`, but only when the
connection itself comes from loopback or a private network (10/8, 172.16/12, 192.168/16, `fc00::/7`): where your
proxy or Docker's port mapping is. A visitor who reaches the studio directly from the internet cannot fake either
header. Make sure your proxy sets both headers (Caddy and Traefik do by default; for nginx add
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` and `proxy_set_header X-Forwarded-Proto $scheme;`).
You can also ban at the proxy: fail2ban or CrowdSec on the proxy's access log (status 401). The studio's lines carry real addresses only when clients connect
straight to the published port (the LAN setup above). A fail2ban filter for them:

```ini
[Definition]
failregex = lazycow auth failed ip=<HOST> method=
```

Point the jail at the container's log (`docker inspect -f '{{.LogPath}}' lazycow-studio-1`) and set
`chain = DOCKER-USER`, because Docker's published ports bypass the `INPUT` chain.

## Sign in to YouTube, Facebook and Bluesky through a tunnel

These sign-ins send your browser back to the studio at a fixed local address: YouTube and Bluesky to
`http://127.0.0.1:4317/oauth/…`, Facebook to `http://localhost:4317/oauth/facebook` (Google Photos import, too, to
`127.0.0.1:4317`). From a browser on another computer that address is that computer itself, not the server. So connect
accounts through an SSH tunnel, once:

1. `ssh -L 4317:127.0.0.1:4317 you@your-server`
2. On your computer open `http://127.0.0.1:4317/?token=<token>`, and for Facebook also
   `http://localhost:4317/?token=<token>` (the browser keeps a token per address).
3. **Settings › Accounts**: connect each network.

The sign-ins are saved in `/data`, so afterwards use the studio from any address. Keep the port 4317 on both sides of
the tunnel and of the `ports:` line: the studio names its own port in these addresses.

## Your AI tool (MCP) on another computer

The MCP server is in the image and finds the studio and its token by itself. Run it over SSH, no port needed:

```sh
claude mcp add lazycow -- ssh you@your-server docker exec -i lazycow-studio-1 node server/mcp.mjs
```

## What does not work in a container

- **X, TikTok, Google Maps, LINE and LinkedIn scheduling, and the Pinterest and Threads helper.** The browser helper
  ([helper.md](helper.md)) drives your own Chrome through the Playwright extension, or opens a Chrome or Edge window
  on screen; a container has neither. Book those from the studio on your own computer, or post them by hand from the
  approved files. YouTube, Facebook Page and Bluesky post from the server as usual.
- **Footage › Collect from others** (the Wi-Fi drop box) shows the container's own address, which phones cannot reach.
- **Folders** are the container's: footage is under `/footage`. Mount more folders read-only below it to add them.
- **No GPU.** Search, tagging and renders run on the processor.
- **Restart and switching projects** end the server process; the container stops and `restart: unless-stopped`
  starts it again on the new project after a few seconds.

## What it needs

The same as on a desktop (README › What you need): at least 4 threads and 6 GB of memory, 8+ threads and 12 GB
recommended; 20 GB or more of free disk for renders. A 9-clip reel takes about 6 to 7 minutes on a 32-thread
desktop processor (median 357 s over 364 builds) and roughly twice that on 8 threads. The image takes about 3.4 GB of
disk. On the first start the footage-search model (about 0.6 GB) downloads into `/data/cache`; until it is in, pages
that need the Python engine (the Overview, Footage) wait.

Free music for the first reels (CC0, from Openverse, a few minutes):
`docker compose exec studio python -m studio audio --seed`.

## Update

```sh
docker compose pull && docker compose up -d
```

Pin a version instead of `latest` with `image: ghcr.io/kensaurus/lazycow-studio:0.24.1`, and read
[CHANGELOG.md](../CHANGELOG.md) before moving the pin. Back up `/data` first (below): a newer studio adds columns to the
catalog in `/data` when it opens it, so going back to an older image means restoring the backup made before the update. To build from
a clone: `git pull && docker compose build && docker compose up -d`.

## Back up

Everything worth keeping is in `/data`; it holds your keys and sign-ins, so keep backups private. With the studio
stopped, from the folder with `compose.yaml`:

```sh
docker compose stop
docker run --rm -v lazycow_studio-data:/data:ro -v "$PWD":/backup debian:bookworm-slim \
  tar czf /backup/lazycow-data.tgz --exclude=./cache -C /data .
docker compose start
```

Restore, with the studio stopped (the volume is made if it does not exist):

```sh
docker compose stop
docker run --rm -v lazycow_studio-data:/data -v "$PWD":/backup debian:bookworm-slim \
  sh -c 'tar xzf /backup/lazycow-data.tgz -C /data && chown -R 10001:10001 /data'
docker compose start
```

The volume's name is the `name:` in `compose.yaml` (`lazycow`) and `_studio-data`. Your footage is not in the
backup: back that up where it lives. The search model in `/data/cache` downloads again by itself.

## Map tiles

Footage › **Where it was filmed** draws OpenStreetMap squares, fetched by the studio (`GET /api/tiles/{z}/{x}/{y}.png`)
and kept in `/data/tiles` (`STUDIO_DATA/tiles` on a desktop), so a browser never talks to the tile server itself. The
studio follows the [OpenStreetMap tile policy](https://operations.osmfoundation.org/policies/tiles/): it names itself
(`User-Agent: LazycowStudio/<version> (+https://github.com/kensaurus/lazycow-studio)`), keeps every square for the
server's cache time and at least 7 days, fetches only the squares a view shows (zoom 3 to 17, no prefetching, two at a
time), and shows the `© OpenStreetMap contributors` credit on the map. Offline, squares seen before still show. The
folder can be deleted at any time; it fills again as you look.

OpenStreetMap's servers are run by volunteers for light use. A studio shared by many people, or one you open on many
machines, should use another provider. Set its tile URL (with `{z}`, `{x}`, `{y}`, and `{s}` if it has subdomains)
and its attribution line in `.env` (or the container's environment), then restart:

```sh
STUDIO_TILE_URL=https://tiles.example.com/{z}/{x}/{y}.png?key=YOUR_KEY
STUDIO_TILE_CREDIT=© Example Maps © OpenStreetMap contributors
```

**Place names** under the map come from [GeoNames](https://www.geonames.org/) (CC BY 4.0). Nothing is downloaded
until someone presses **Get place names** (about 11 MB for the world's towns, then optionally one country's detail,
about 5 MB for Japan) or runs `python -m studio places download world` (or `JP`). The files go to `/data/places`;
`python -m studio places status` says what is there.

## Advanced settings

Most people never need these: the studio's own **Settings** (Everyday first, the rest under **Advanced**) covers
the everyday choices. Each line below is a variable from [`.env.example`](../.env.example), which says more about it.
Set it in `.env` (or the container's environment) and restart. `test/env-example.test.mjs` keeps this table and
`.env.example` in step.

| Variable | What it does |
| --- | --- |
| `STUDIO_DATA` | Where the catalog, proxies, renders and tools live (default `./data` beside the code). |
| `STUDIO_SOURCE` | The footage folder, read only (default `STUDIO_DATA/footage`). |
| `STUDIO_PY` | The Python the studio runs (default the venv in `STUDIO_DATA`). |
| `STUDIO_TOOLS` | The folder with ffmpeg and ffprobe (default `STUDIO_DATA/bin`). |
| `STUDIO_FFMPEG` | One particular ffmpeg, used as it is. |
| `STUDIO_FFPROBE` | One particular ffprobe, used as it is. |
| `STUDIO_TAKEOUT` | Where Google Takeout zips are read from. |
| `STUDIO_API_TOKEN` | A token every caller must carry; required in server mode (24+ characters). |
| `STUDIO_HOST` | The address the studio listens on (empty = this computer only). |
| `STUDIO_ALLOWED_HOSTS` | Every name a browser reaches the studio by, comma-separated. |
| `STUDIO_TRUST_PROXY` | `1` behind a reverse proxy: believe X-Forwarded-For and X-Forwarded-Proto from it. |
| `LAZYCOW_FOOTAGE` | Docker Compose only: the footage folder mounted read-only at `/footage`. |
| `LAZYCOW_DIR` | The studio folder the MCP server and `npx lazycow` read `.env` from. |
| `STUDIO_DROP_PORT` | The Wi-Fi drop box port (default 4319). |
| `STUDIO_FB_APP_ID` | Your Meta app's ID, for Facebook Page posting. |
| `STUDIO_FB_APP_SECRET` | Your Meta app's secret, for Facebook Page posting. |
| `STUDIO_WORDS` | The word bank file (default beside the project's reels). |
| `STUDIO_WEBSITE_ENV` | A website `.env` to borrow an OpenRouter key from. |
| `OPENROUTER_API_KEY` | Paid tagging only; the editor, grade and music do not need it. |
| `STUDIO_DAILY_USD_BUDGET` | The hard stop for paid calls, per local day, in US dollars. |
| `STUDIO_GAP_CONFIRM` | `1` only when a person approved a gap-fill video spend. |
| `STUDIO_EXTRA_SOURCES` | More footage folders outside `STUDIO_SOURCE`, semicolon-separated. |
| `STUDIO_WATCH_MINUTES` | Minutes between checks of every footage folder for new files (`0` = off). |
| `STUDIO_YT_CLIENT_ID` | Your Google Cloud desktop OAuth client ID, for YouTube posting. |
| `STUDIO_YT_CLIENT_SECRET` | Its secret. |
| `STUDIO_TZ` | Your audience's time zone; post times are picked and shown in it. |
| `STUDIO_TILE_URL` | Another map tile provider's URL (default OpenStreetMap). |
| `STUDIO_TILE_CREDIT` | That provider's attribution line. |
| `STUDIO_GBP_LOCATION` | The Google Maps listing the browser helper posts on. |
| `STUDIO_HELPER_BROWSER` | Which browser the helper drives: `extension` (your Chrome) or `own`. |
| `PLAYWRIGHT_MCP_EXTENSION_TOKEN` | Skips the extension's one "Allow & select" click; a key to your browser. |
| `STUDIO_WORKSPACE` | The name shown beside the logo. |
| `STUDIO_HOME` | Where the list of projects lives (default `~/.lazycow`). |
| `STUDIO_PORT` | The port (default 4317); a second studio runs on another. |
| `STUDIO_QUIET` | `1`: a studio for looking only; nothing runs by itself, settings and usage counts stay in memory. |
| `STUDIO_PROJECT` | Pins a second studio to one project. |
| `STUDIO_DRAFTS` | A project's drafts folder (set per project by itself). |
| `STUDIO_READY` | A project's approved-files folder (set per project by itself). |
| `STUDIO_PROJECTS` | A project's reel files folder (set per project by itself). |
| `STUDIO_RANCH` | The original workspace switch (the ranch overlay, not in a public copy); leave empty. |
| `FAL_KEY` | fal.ai, for AI touches (slow motion, sharpen, music, voice, living photo). |
| `OPENROUTER_API_KEY_PARKED` | The AI reviewer's OpenRouter key (kept apart from paid tagging). |
| `STUDIO_PAID_TAGGING` | `on` turns paid tagging on with the reviewer's key. |
| `TOGETHER_API_KEY` | Together AI. |
| `ELEVENLABS_API_KEY` | ElevenLabs voices and sound effects. |
| `STABILITY_API_KEY` | Stability AI music and sound. |
| `REPLICATE_API_TOKEN` | Replicate models (music, upscale, image-to-video, background removal, speech). |
| `KIE_API_KEY` | kie.ai. |
| `RUNWAY_API_KEY` | Runway image-to-video. |
| `MINIMAX_API_KEY` | MiniMax image-to-video and voices. |
| `HIGGSFIELD_API_KEY` | Higgsfield image-to-video (`<key id>:<key secret>`). |
| `GEMINI_API_KEY` | Google Gemini, for writing help and picture questions. |
| `PIAPI_API_KEY` | PiAPI (never a default). |
| `LUMA_AGENTS_API_KEY` | Luma image-to-video. |
| `STUDIO_AI_REEL_CAP_USD` | The AI spending limit per reel, in US dollars. |
| `STUDIO_AI_TOTAL_CAP_USD` | The limit for all AI spending together. |
| `STUDIO_AI_REVIEW_MODEL` | The reviewer's OpenRouter model. |
| `STUDIO_AI_REVIEW_LOCAL` | `1`: review on your own vision model from still frames. |
| `STUDIO_LLM_BASE_URL` | Your own model server (anything that speaks the OpenAI chat API). |
| `STUDIO_LLM_MODEL` | Its model for writing jobs. |
| `STUDIO_LLM_VISION_MODEL` | Its model that reads pictures. |
| `STUDIO_LLM_API_KEY` | Its key, if it asks for one. |
| `STUDIO_WHISPER_BACKEND` | Subtitles for long videos: `auto`, `faster-whisper`, `mlx` or `off`. |
| `STUDIO_WHISPER_MODEL` | The speech model. |
| `STUDIO_WHISPER_LANGUAGE` | The speech kept: a language code or a comma list. |
| `STUDIO_AESTHETIC_FETCH` | `0` never downloads the small picture-quality model. |
| `STUDIO_VLOG_CONCURRENCY` | Render tabs a long video uses at once (1-16). |
| `STUDIO_YT_CHANNEL` | The only YouTube channel this project may upload to. |
| `STUDIO_AUTO_DRAFTS` | Draft reels made by themselves per day (`0` = off); wins over Settings. |
| `STUDIO_GPHOTOS_ACCOUNT` | The Google account Photos are imported from. |
| `STUDIO_LINKEDIN_PAGE` | The LinkedIn company page reels are scheduled on. |
| `FIRECRAWL_API_KEY` | Firecrawl, for the Ideas tools. |
| `STUDIO_RESEARCH_DAILY_CAP` | Live Firecrawl requests per day (default 60). |
| `STUDIO_PERF_STEER` | `1` or `0`: whether new reels use what worked; wins over Settings. |
| `CHROME_PATH` | Google Chrome for recording the docs GIFs. |

## Licences

The studio is Apache-2.0. The words on screen are drawn with Remotion, which has its own licence: free for
individuals and companies of up to 3 people; a larger for-profit company needs a Remotion company licence
([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
