FROM node:22-alpine

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/simulator-worker/package.json apps/simulator-worker/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/shared-schema/package.json packages/shared-schema/package.json
RUN pnpm install --frozen-lockfile --filter @claimguard/simulator-worker... --filter @claimguard/api...

COPY apps/api/src apps/api/src
COPY apps/simulator-worker/src apps/simulator-worker/src
COPY packages/database/src packages/database/src
COPY packages/shared-schema/src packages/shared-schema/src

CMD ["node", "apps/simulator-worker/src/cli.js", "tick"]
