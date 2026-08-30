# iCode Host Pro — Fundamental Project Pack

**iCode Host Pro** = self-hosted hosting control plane (multiple products, servers
and infrastructure providers; orchestrates existing systems rather than recreating them).

**Single source of continuity.** Read `PROJECT_CONTEXT.md`, `DECISIONS.md`,
`PROJECT_STATUS.md`, `TASKS.md`, `HANDOVER.md`, `CHANGELOG.md`, `MASTER_PROMPT.md`
and the `docs/` references before changing the project.

**Critical rule:** a recommendation is NEVER `APPROVED` unless explicitly approved
by the owner. See `DECISIONS.md`.

---

## Monorepo layout (Phase 0 — Architecture & Foundations)

State as of Phase 0 implementation. See `PROJECT_STATUS.md` for live status.

```
package.json          pnpm workspaces root + turbo scripts (ADR-001)
pnpm-workspace.yaml   workspaces: apps/*, packages/*
turbo.json            turbo task graph
docker-compose.yml    dev infra: PostgreSQL only, no Redis (ADR-012)
.nvmrc                Node 22
apps/
  web/  Next.js App Router frontend + diagnostic page (ADR-002)
  api/  NestJS backend, /api/health, Prisma, OpenAPI (ADR-003/004/005)
packages/             reserved for shared code (none created yet — no premature complexity)
docs/                 plan-infrastructure.md, sql-commandes.txt, architecture references
```

Phase 0 creates **no business tables** (ADR-014): Prisma proves connectivity via a
real `SELECT 1`, the only DB artifact is Prisma's `_prisma_migrations` baseline.

### Quick start (development)

```bash
pnpm install            # workspaces
pnpm db:up              # start PostgreSQL container (Docker Desktop)
pnpm --filter @icode-host-pro/api generate   # generate Prisma client
pnpm --filter @icode-host-pro/api migrate    # apply baseline migration
pnpm dev                # run web + api (turbo)
```

Copy each `apps/*/.env.example` to `apps/*/.env` first (ADR-011 socle).