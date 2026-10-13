# syntax=docker/dockerfile:1
# Code Diali — image API (NestJS + Prisma CLI pour migrations protégées).
# Build context = racine du dépôt. NE CONTIENT AUCUN SECRET (voir deploy/.env.example).
# Aucun migrate/seed au démarrage : CMD = simple démarrage du serveur.

########## deps : monorepo pnpm (filtre API, devDeps inclus -> prisma CLI dispo) ##########
FROM node:22-bookworm-slim AS deps
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# openssl : requis par le moteur Prisma (le detect auto échoue sur bookworm-slim
# sans lui, et le client généré refuserait de se connecter au runtime).
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/README.md packages/README.md
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @codediali/api...

########## build : prisma generate + nest build ##########
FROM deps AS build
COPY apps/api apps/api
# "pnpm --filter pkg exec bin" exécute le BINAIRE dans le package (cwd + .bin) ;
# "pnpm --filter pkg bin" n'exécute que les scripts du package (piège : le
# generate ne tournerait pas silencieusement — cause racine du build initial).
RUN pnpm --filter @codediali/api exec prisma generate \
 && pnpm --filter @codediali/api run build

########## api : runtime — client Prisma généré + dist + prisma CLI (migrations) ##########
FROM node:22-bookworm-slim AS api
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
# Outil de sauvegarde exigé par deploy/scripts/migrate-guarded.sh (backup préalable).
# postgresql-client-16 via PGDG : le client Debian bookworm (15) REFUSE de dumper un
# serveur 16 ("server version mismatch") — compatibilité majeure obligatoire.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-16 openssl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
# Structure pnpm conservée (symlinks relatifs .pnpm valides une fois copiés ensemble).
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/apps/api/node_modules /repo/apps/api/node_modules
COPY --from=build /repo/apps/api/dist /repo/apps/api/dist
COPY --from=build /repo/apps/api/prisma /repo/apps/api/prisma
# package.json requis au runtime : Prisma y lit le script "prisma.seed"
# (npx prisma db seed) — sans lui, le seed est un no-op silencieux.
COPY --from=build /repo/apps/api/package.json /repo/apps/api/package.json
COPY deploy/scripts /opt/code-diali/scripts
# cwd = apps/api : les chemins relatifs du code (storage/, public/branding/) sont stables.
WORKDIR /repo/apps/api
EXPOSE 3001
# Démarrage simple. Jamais de migrate/seed implicite (décision GO §2/§4).
# Migrations : docker compose run --rm api bash /opt/code-diali/scripts/migrate-guarded.sh
# Seed admin : docker compose run --rm api npx prisma db seed (explicite, env ADMIN_* fournies).
CMD ["node", "dist/src/main.js"]
