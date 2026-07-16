FROM node:22-alpine AS base
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/provisioning-worker/package.json ./apps/provisioning-worker/package.json
COPY packages/control-plane-database/package.json ./packages/control-plane-database/package.json

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
RUN pnpm install --filter @claimguard/provisioning-worker --filter @claimguard/control-plane-database --prod --no-frozen-lockfile

COPY apps/provisioning-worker ./apps/provisioning-worker
COPY packages/control-plane-database ./packages/control-plane-database

WORKDIR /app/apps/provisioning-worker
CMD ["node", "src/cli.js", "run-once"]
