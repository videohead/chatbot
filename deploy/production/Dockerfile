FROM node:22-bookworm AS base

WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

FROM base AS dependencies
COPY package.json pnpm-lock.yaml ./
RUN HUSKY=0 pnpm install --frozen-lockfile

FROM base AS builder
ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
# Fail closed before application compilation if the generated catalog contains
# unknown fields or a credential-shaped value.
RUN node deploy/production/validate-model-catalog.mjs model-catalog.json
# The package build wrapper also runs a database migration. Image creation must
# remain free of database side effects, so invoke Next.js directly here.
RUN pnpm exec next build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

RUN apt-get update \
    && apt-get install --yes --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/logs /app/generated-media \
    && chown -R node:node /app

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/model-catalog.json ./model-catalog.json
COPY --chown=root:root deploy/production/entrypoint.sh /usr/local/bin/chatbot-entrypoint
RUN chmod 0755 /usr/local/bin/chatbot-entrypoint

# Compose file-backed secrets retain their root-only host permissions. Read
# them here, then immediately drop to the unprivileged node account.
USER root
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/chatbot-entrypoint"]
CMD ["node", "server.js"]
