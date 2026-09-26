# Builds separate trusted-service and restricted-agent images.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS service
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
USER node
CMD ["node", "dist/src/main.js"]

FROM node:22-bookworm-slim AS agent
WORKDIR /agent
COPY scripts/agent.mjs ./agent.mjs
USER node
CMD ["node", "agent.mjs"]
