# PROJECT_CONTEXT — iCode Host Pro

## Product
A self-hosted hosting control plane intended to manage multiple products, servers and infrastructure providers. It orchestrates existing systems rather than unnecessarily recreating them.

Potential directions include managed deployments, Git projects, managed WordPress, domains/DNS, databases, email products and future hosting services.

## Architecture direction discussed so far
Monorepo, pnpm workspaces, Turborepo, Next.js, NestJS, PostgreSQL, Prisma, REST/OpenAPI, provider adapters, asynchronous provisioning, Docker development and secure self-hosted installation. These are proposals unless DECISIONS.md says APPROVED.

## Principles
Security first; self-hosted simplicity; modular boundaries; no provider leakage into core; no secrets in Git; runtime-specific configuration not hard-coded; phase-by-phase testing; continuity for future AIs; avoid premature complexity.

## Database philosophy
The AI makes normal technical database decisions inside the authorized phase. The owner tests functional results rather than approving every table or query. After each database phase, document tables created/modified/removed, migrations and useful SQL in docs/sql-commandes.txt.

## Task history
TASKS.md must log all meaningful work, including small changes: analysis, files created/modified/deleted, commands, database actions, tests, fixes, configuration and blockers.

## Decision discipline
PROPOSED = recommendation only. APPROVED = explicit owner approval. REJECTED = explicit rejection. Never infer approval.

## Reset objective
The project is restarting from a clean baseline. A new AI must first analyze the repository and return an assessment before broad implementation.

## Source priority
1. Current explicit owner instruction.
2. DECISIONS.md for decision status.
3. PROJECT_STATUS.md for current state.
4. TASKS.md for detailed history.
5. CHANGELOG.md and HANDOVER.md.
6. PROJECT_CONTEXT.md and reference documents.
