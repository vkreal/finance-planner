# Finance Planner Assistant API — Dockerfile
#
# Build context is the REPO ROOT (this Dockerfile lives at
# assistant-api/Dockerfile in the repo):
#   docker build -f assistant-api/Dockerfile -t fp-assistant-api .
#
# Run (token required; the server refuses to boot without it):
#   docker run -e ASSISTANT_API_TOKEN=<your-long-random-token> -p 8080:8080 fp-assistant-api
#
# Design: the module has no dependencies of its own, but the adapter's
# schema/normalize layer needs zod (pinned to the repo's 4.4.3). Instead of
# copying the repo's node_modules (heavy) or running the repo's own install
# (known-flaky in fresh clones), the image copies only the runtime closure —
# assistant-api/src, server/src and this Dockerfile — writes a minimal
# /app/package.json pinning zod@4.4.3, and runs `bun install` from the npm
# registry at build time. If the adapter ever imports beyond server/src
# (e.g. drizzle or the space SDK), the COPY list below is the place to widen.
# No secrets are baked into the image: the token is env-only at run time.

FROM oven/bun:1.4
WORKDIR /app

COPY assistant-api/src ./assistant-api/src
COPY server/src ./server/src

RUN printf '%s\n' '{' \
  '  "name": "finance-planner-assistant-api-runtime",' \
  '  "private": true,' \
  '  "type": "module",' \
  '  "dependencies": { "zod": "4.4.3" }' \
  '}' > package.json \
  && bun install

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://localhost:8080/health'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "assistant-api/src/server.ts"]
