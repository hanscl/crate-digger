# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile=false

FROM deps AS build
COPY . .
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/tsconfig.json ./tsconfig.json
USER node
EXPOSE 3000
CMD ["pnpm", "start"]
