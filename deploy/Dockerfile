# M1 container floor (docs/deploy-box-tailscale.md "M1 Container floor").
#
# Base pinned by digest, checked 2026-09-03 via `docker pull oven/bun:1.3.10`:
#   docker.io/oven/bun:1.3.10
#   Digest: sha256:b86c67b531d87b4db11470d9b2bd0c519b1976eee6fcd71634e73abfa6230d2e
FROM oven/bun@sha256:b86c67b531d87b4db11470d9b2bd0c519b1976eee6fcd71634e73abfa6230d2e

# curl is installed only so deploy/proof/container.sh can run the exact
# `curl -fsS 127.0.0.1:$PORT/health` the plan's finish line names (check 1.4).
# This is a build-time apt fetch; the resulting image needs no network
# (checks 1.2 and 1.9 run every container with `--network none`).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
COPY deploy/fixtures/notes /fixtures

RUN bun install --frozen-lockfile && chown -R bun:bun /app

COPY deploy/bin/kizuki deploy/bin/kizuki-mcp deploy/bin/kizuki-reindex /usr/local/bin/
COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod 0755 \
      /usr/local/bin/kizuki \
      /usr/local/bin/kizuki-mcp \
      /usr/local/bin/kizuki-reindex \
      /entrypoint.sh \
    && mkdir -p /vault \
    && chown bun:bun /vault

VOLUME /vault
USER bun
ENV HOME=/tmp
ENTRYPOINT ["/entrypoint.sh"]
