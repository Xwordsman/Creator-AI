FROM node:24.18.0-bookworm-slim AS build
RUN npm install --global pnpm@11.25.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/web ./apps/web
COPY apps/server/package.json ./apps/server/package.json
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @creator-ai/contracts build && pnpm --filter @creator-ai/web build

FROM caddy:2.10.2-alpine
COPY infra/docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
