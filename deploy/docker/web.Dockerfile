# syntax=docker/dockerfile:1
# Code Diali — image Web (Next.js 15).
# Build context = racine du dépôt. AUCUN SECRET au build : API_UPSTREAM/NEXT_PUBLIC_API_URL
# sont des URL (pas des clés). Les valeurs sensibles sont runtime-only (voir .env.example).

########## deps ##########
FROM node:22-bookworm-slim AS deps
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/README.md packages/README.md
RUN --mount=type=cache,id=pnpm-store-web,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @codediali/web...

########## build : next build (API_UPSTREAM + NEXT_PUBLIC_API_URL figés ici) ##########
FROM deps AS build
COPY apps/web apps/web
# next build n'exige pas public/, mais le stage runtime le copie : le créer
# garantit le COPY même sur un arbre sans assets statiques.
RUN mkdir -p apps/web/public
# API_UPSTREAM = URL de l'API telle que vue PAR LE CONTENEUR WEB (jamais localhost
# entre conteneurs distincts). NEXT_PUBLIC_API_URL = URL de l'API telle que vue PAR
# LE NAVIGATEUR (fetch /api/brand côté client).
ARG API_UPSTREAM=http://api:3001
ARG NEXT_PUBLIC_API_URL=http://localhost:3111
ENV API_UPSTREAM=${API_UPSTREAM}
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_TELEMETRY_DISABLED=1
# Plafond mémoire explicite (Next 15 sur machine à RAM modeste — ex. VM 4 Gio).
ENV NODE_OPTIONS=--max-old-space-size=3072
RUN pnpm --filter @codediali/web build

########## runtime ##########
FROM node:22-bookworm-slim AS web
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/apps/web/node_modules /repo/apps/web/node_modules
COPY --from=build /repo/apps/web/.next /repo/apps/web/.next
COPY --from=build /repo/apps/web/public /repo/apps/web/public
COPY --from=build /repo/apps/web/package.json /repo/apps/web/package.json
COPY --from=build /repo/apps/web/next.config.mjs /repo/apps/web/next.config.mjs
WORKDIR /repo/apps/web
EXPOSE 3000
CMD ["node_modules/next/dist/bin/next", "start", "-p", "3000"]
