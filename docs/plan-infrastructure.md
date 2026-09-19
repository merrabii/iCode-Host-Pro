# Infrastructure Plan — Working Reference

Current direction under discussion: Docker development, PostgreSQL candidate, optional Redis depending on jobs architecture, separate frontend/backend applications and provider adapters. Production reverse proxy/SSL remains to be finalized.

Do not record unapproved recommendations as approved architecture.

## 2026-09-19 — ADR-041 Rate-limit admin du statut public de commande + TRUST_PROXY (IMPLEMENTED + VERIFIED)

- **Endpoint public** : `GET /api/store/orders/:id/status` → `{found: boolean, status?: string}` (sans PII).
- **Rate-limit** : HTTP 429 + `Retry-After` (secondes). Admin-configurable via `SecuritySetting` singleton.
- **Configuration admin** : `enabled` (bool, défaut `true`), `max` (5..1000, défaut `30`), `windowSec` (10..3600, défaut `60`).
- **Cache TTL 30 s** mémoire + invalidation immédiate après update admin.
- **TRUST_PROXY** : défaut `false` (X-Forwarded-For ignoré, `req.ip` = socket). `"true"` REFUSÉ. Seuls IP/CIDR explicites (ex. `172.18.0.0/16`) ou presets `loopback/linklocal/uniquelocal`. Pas de nombre de hops.
- **Mono-instance actuelle** : `SaRateLimiter` (fenêtre glissante mémoire par IP) suffit. Store partagé (Redis) requis seulement en multi-réplicas (ADR-007 PROPOSED).
- **Migration additive** : 3 colonnes `SecuritySetting`, défauts `true/30/60`, aucun DROP/backfill.
- **Validations** : unit 495/495 (38 suites), e2e 150/150 (20 suites), typecheck/build API/Web PASS.
