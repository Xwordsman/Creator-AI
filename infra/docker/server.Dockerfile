FROM node:24.18.0-bookworm-slim AS build
RUN npm install --global pnpm@11.25.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/server ./apps/server
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @creator-ai/contracts build && pnpm --filter @creator-ai/server build
RUN pnpm --filter @creator-ai/server deploy --prod --legacy /release

FROM node:24.18.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /release ./
USER node
EXPOSE 3000 3001
CMD ["node", "dist/main-api.js"]
