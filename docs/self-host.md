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
echo "STUDIO_API_TOKEN=$(openssl rand -hex 16)" >> .env
echo "LAZYCOW_FOOTAGE=/srv/footage" >> .env      # your footage folder on this server (read only); default ./footage
docker compose up -d
```

Then open `http://127.0.0.1:4317/?token=<your token>` once. The browser keeps the token (a cookie for a year) and
drops it from the address. Programs send `Authorization: Bearer <token>` instead. `GET /api/health` is the only
address that answers without it.

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
- **Your LAN, plain HTTP**: change the port line to `"4317:4317"` and set
  `STUDIO_ALLOWED_HOSTS=192.168.1.20:4317` (the server's address). The token then crosses your network unencrypted,
  so prefer one of the above.

Run `docker compose up -d` again after changing `.env`. A name that is not listed gets "the studio only answers its own
page on this machine" (403).

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

Free music for the first reels (CC0, from Openverse, about a minute):
`docker compose exec studio python -m studio audio --seed`.

## Update

```sh
docker compose pull && docker compose up -d
```

Pin a version instead of `latest` with `image: ghcr.io/kensaurus/lazycow-studio:0.24.0`. To build from a clone:
`git pull && docker compose build && docker compose up -d`.

## Back up

Everything worth keeping is in `/data`; it holds your keys and sign-ins, so keep backups private. With the studio
stopped, from the folder with `compose.yaml`:

```sh
docker compose stop
docker run --rm -v lazycow_studio-data:/data:ro -v "$PWD":/backup debian:bookworm-slim \
  tar czf /backup/lazycow-data.tgz --exclude=./cache -C /data .
docker compose start
```

Restore into an empty volume the same way with `tar xzf /backup/lazycow-data.tgz -C /data` (then
`chown -R 10001:10001 /data`). Your footage is not in it: back that up where it lives.
