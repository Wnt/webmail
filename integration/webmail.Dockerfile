# Webmail image for integration testing — runs Next.js in DEVELOPMENT mode.
#
# Why dev mode rather than the production Dockerfile at the repo root?
# The browser talks JMAP directly to Stalwart at http://localhost:8025 (plain
# HTTP, cross-origin). The app's production Content-Security-Policy pins
# connect-src to `'self' https:`, which would block that plaintext cross-origin
# fetch. In development mode proxy.ts widens connect-src to `'self' http:
# https: ws: wss:` — exactly what a local, TLS-less Stalwart needs. Running
# from source also ships the integration-test data-testid hooks without a
# production rebuild.
#
# Build context is the repo root (see docker-compose.yml `context: ..`), so the
# root .dockerignore keeps examples/, integration/ and node_modules out.

# Base images are pinned as tag@sha256:<multi-arch index digest>. To bump, change
# the tag and digest together: docker buildx imagetools inspect <image>:<tag>
FROM node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app

# Install dependencies first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# App source (data-testid hooks included).
COPY . .

ENV NODE_ENV=development
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

EXPOSE 3000

# Bind to 0.0.0.0 so the published port is reachable from the host/browser.
CMD ["npx", "next", "dev", "-H", "0.0.0.0", "-p", "3000"]
