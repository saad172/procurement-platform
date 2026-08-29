# One image, two commands: `next start` for the web service and `node worker.js`
# for the worker (SPEC §2.2). Building both from one Dockerfile is what keeps
# them running the same Tool Runner code rather than two copies of it.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ── deps ─────────────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ── build ────────────────────────────────────────────────────────────────────
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY package.json next.config.ts tsconfig.json drizzle.config.ts ./
COPY src ./src

EXPOSE 3100
CMD ["pnpm", "start"]
