# complykit service: the web UI/API (service/) plus the complykit CLI it runs.
# The Playwright base image ships Chromium + its system deps at /ms-playwright;
# its tag must match the playwright version complykit resolves (1.62.1).

# --- build ---------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY service/package.json service/package-lock.json ./service/
RUN cd service && npm ci --no-audit --no-fund

# The consent tool (client/) the install bundle ships. Its playwright is a test
# dependency only; the base image already has the browsers.
COPY client/package.json client/package-lock.json ./client/
RUN cd client && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund

COPY . .
RUN npm run build && (cd client && npm run build && npm run size) && cd service && npm run build

# --- runtime -------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.62.1-noble
# tini as PID 1 reaps orphaned Chromium processes (Node doesn't) and forwards
# signals to the server.
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

# complykit: production deps only. playwright is a peer/devDependency there but
# required at runtime, so carry the exact build-time copy over.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/node_modules/playwright ./node_modules/playwright
COPY --from=build /app/node_modules/playwright-core ./node_modules/playwright-core
COPY --from=build /app/dist ./dist

# service: production deps + compiled server + built client.
COPY service/package.json service/package-lock.json ./service/
RUN cd service && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/service/dist ./service/dist
# The two consent-tool files the install bundle zips (service default:
# ../client/dist relative to service/).
COPY --from=build /app/client/dist/complykit-consent.js /app/client/dist/complykit-consent-ui.js ./client/dist/
COPY service/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /data && chown pwuser:pwuser /data
EXPOSE 8080
# Starts as root only long enough to chown the volume, then runs as pwuser.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "service/dist/server/index.js"]
