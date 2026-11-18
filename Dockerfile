# syntax=docker/dockerfile:1
# Lazycow Studio in a container: the studio server (Node), the Python pipeline with CPU-only PyTorch, ffmpeg and
# Remotion's Chrome Headless Shell, for a home server or a VPS. How to run it: docs/self-host.md (compose.yaml).
# Build: docker build -t lazycow-studio .        (linux/amd64 and linux/arm64; .github/workflows/docker.yml publishes both)
# Nothing secret is baked in: the API token, keys and sign-ins come from the environment and the /data volume.

ARG NODE_IMAGE=node:24-bookworm-slim
ARG PYTHON_IMAGE=python:3.13-slim-bookworm
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.13.5

FROM ${NODE_IMAGE} AS node
FROM ${UV_IMAGE} AS uv

# ---- Python packages: the same hash-checked lock and CPU torch the Linux setup installs (scripts/bootstrap/linux.sh) ----
FROM ${PYTHON_IMAGE} AS pydeps
ARG TARGETARCH
COPY --from=uv /uv /usr/local/bin/uv
COPY py/requirements-linux.lock py/requirements-linux-arm64.lock /tmp/py/
ENV UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 UV_PYTHON_DOWNLOADS=never
RUN --mount=type=cache,target=/root/.cache/uv \
    case "${TARGETARCH:-amd64}" in \
      amd64) lock=requirements-linux.lock ;; \
      arm64) lock=requirements-linux-arm64.lock ;; \
      *) echo "Lazycow Studio runs on linux/amd64 or linux/arm64, not ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && uv venv /opt/venv --python /usr/local/bin/python3 \
 && uv pip sync --python /opt/venv/bin/python --torch-backend cpu --require-hashes "/tmp/py/$lock"

# ---- The image ----
FROM ${PYTHON_IMAGE}
LABEL org.opencontainers.image.title="Lazycow Studio" \
      org.opencontainers.image.description="Turn your own footage into short vertical videos, on your own server." \
      org.opencontainers.image.source="https://github.com/kensaurus/lazycow-studio" \
      org.opencontainers.image.documentation="https://github.com/kensaurus/lazycow-studio/blob/main/docs/self-host.md" \
      org.opencontainers.image.licenses="Apache-2.0"

# ffmpeg (Debian 12: 5.1, the studio's minimum), tini (reaps the ffmpeg, Python and Chrome children), libsndfile, the
# libraries Chrome Headless Shell needs (remotion.dev/docs/docker) and fonts for Japanese and emoji captions.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ffmpeg tini ca-certificates libsndfile1 \
      libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libgbm1 libasound2 libxrandr2 libxkbcommon0 libxfixes3 \
      libxcomposite1 libxdamage1 libpango-1.0-0 libcairo2 libcups2 \
      fonts-dejavu-core fonts-noto-cjk fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && groupadd --gid 10001 lazycow \
 && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/lazycow --shell /usr/sbin/nologin lazycow \
 && mkdir -p /app /data /footage \
 && chown 10001:10001 /app /data

COPY --from=pydeps /opt/venv /opt/venv

WORKDIR /app
USER 10001:10001
# npm packages and Remotion's Chrome Headless Shell, before the source so a code change does not reinstall them.
COPY --chown=10001:10001 package.json package-lock.json ./
RUN --mount=type=cache,target=/home/lazycow/.npm,uid=10001,gid=10001 \
    npm ci --omit=dev --no-audit --no-fund --loglevel=error \
 && npx remotion browser ensure

COPY --chown=10001:10001 . .
# Big working files go to the /data volume, not the container: public/mezz (a long video's clips reach 100 GB) and
# public/stills. Settings saved in the studio (keys, AI choices) go to /data/.env.
RUN rm -rf public/mezz public/stills .env \
 && ln -s /data/mezz public/mezz \
 && ln -s /data/stills public/stills \
 && ln -s /data/.env .env \
 && mkdir -p .remotion-public node_modules/.cache

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONPATH=/app/py \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    XDG_CACHE_HOME=/data/cache \
    STUDIO_HOST=0.0.0.0 \
    STUDIO_PORT=4317 \
    STUDIO_ALLOWED_HOSTS=localhost:4317,127.0.0.1:4317 \
    STUDIO_DATA=/data \
    STUDIO_SOURCE=/footage \
    STUDIO_HOME=/data/home \
    STUDIO_PY=/opt/venv/bin/python

EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.STUDIO_PORT||4317)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
# The server refuses to start (exit 78, with the reason) without STUDIO_API_TOKEN of 24+ characters: docs/self-host.md.
CMD ["sh", "-c", "mkdir -p /data/mezz /data/stills || { echo \"Cannot write to /data. Give it to user 10001: chown -R 10001:10001 <your data folder>\" >&2; exit 73; }; exec node server/review.mjs"]
