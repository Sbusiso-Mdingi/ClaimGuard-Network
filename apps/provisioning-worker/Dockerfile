FROM node:26-alpine AS base
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/provisioning-worker/package.json ./apps/provisioning-worker/package.json
COPY packages/control-plane-database/package.json ./packages/control-plane-database/package.json
COPY packages/database/package.json ./packages/database/package.json

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
RUN pnpm install --filter @claimguard/provisioning-worker --filter @claimguard/control-plane-database --filter @claimguard/database --prod --frozen-lockfile

COPY apps/provisioning-worker ./apps/provisioning-worker
COPY packages/control-plane-database ./packages/control-plane-database
COPY packages/database ./packages/database

WORKDIR /app/apps/provisioning-worker
CMD ["node", "src/cli.js", "run-once"]
