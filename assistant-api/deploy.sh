#!/usr/bin/env bash
# deploy.sh — one-command remote deploy of the Finance Planner assistant API.
#
# Usage (from the repo root):
#   ASSISTANT_API_TOKEN=<long-random-token> assistant-api/deploy.sh
#
# What it does:
#   1. Builds the image:
#        docker build -f assistant-api/Dockerfile -t fp-assistant-api .
#   2. Runs it detached on 0.0.0.0:8080 with the token:
#        docker run -d --name fp-assistant-api -p 0.0.0.0:8080:8080 \
#          -e ASSISTANT_API_TOKEN -e HOST=0.0.0.0 -e PORT=8080 fp-assistant-api
#   3. Prints a health-check command.
#
# Notes:
# - The token comes from ASSISTANT_API_TOKEN only. The script refuses to run
#   without it, passes it to the container by name (-e ASSISTANT_API_TOKEN,
#   so the value never appears in the command line), and never echoes it.
#   No token is baked into the image.
# - HOST=0.0.0.0 is passed explicitly: the server defaults to binding
#   127.0.0.1, which inside a container would not be reachable through the
#   published port. A non-loopback bind without a token refuses to boot,
#   so the token is required (see assistant-api/src/server.ts for the rule).
# - The build context is the repo root, because the Dockerfile copies
#   assistant-api/src and server/src. The script cds to the repo root (the
#   parent of the directory holding this script), so it works when invoked
#   as `assistant-api/deploy.sh` from the repo root — and from elsewhere.
# - Re-running replaces the previous container (same name, --restart
#   unless-stopped).
# - The host-side port can be changed with PORT (default 8080); the
#   container always listens on 8080.
# - UNEXECUTED in this VM: there is no docker binary here, so this script
#   was written and reviewed by reading only (syntax-checked with
#   `bash -n`); it has not been run.

set -euo pipefail

if [ -z "${ASSISTANT_API_TOKEN:-}" ]; then
  echo "error: ASSISTANT_API_TOKEN is not set." >&2
  echo "Set it to a long random bearer token, e.g.:" >&2
  echo "  ASSISTANT_API_TOKEN=\$(openssl rand -hex 32) assistant-api/deploy.sh" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

if [ ! -f assistant-api/Dockerfile ]; then
  echo "error: assistant-api/Dockerfile not found under $REPO_ROOT — run from the repo root or check the checkout." >&2
  exit 1
fi

IMAGE="fp-assistant-api"
CONTAINER="fp-assistant-api"
PORT="${PORT:-8080}"

docker build -f assistant-api/Dockerfile -t "$IMAGE" .

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  -p "0.0.0.0:${PORT}:8080" \
  -e ASSISTANT_API_TOKEN \
  -e HOST=0.0.0.0 \
  -e PORT=8080 \
  "$IMAGE"

echo "Deployed $CONTAINER on 0.0.0.0:${PORT} (container port 8080)."
echo "Health check (no auth needed): curl -s http://localhost:${PORT}/health"
echo "MCP endpoint: POST https://<host>/mcp with header 'Authorization: Bearer <token>'."
