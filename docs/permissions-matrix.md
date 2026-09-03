# Matrice des permissions — API

Vérifiée le 2026-09-03 sur le code réel (controllers + guards), Phase 11 (ADR-028).
Source unique des rangs : `apps/api/src/auth/roles.ts` (`ROLE_RANK`).

- **Public** : aucune authentification requise.
- **Auth (tout rôle)** : tout utilisateur connecté (rôle ≥ USER).
- **ADMIN** : rang ≥ 99 → seul `ADMIN`.
- **SUPPORT_L1+** : rang ≥ 1 → L1 / L2 / L3 / ADMIN.
- **SUPPORT_L2+** : rang ≥ 2 → L2 / L3 / ADMIN.
- **SUPPORT_L3+** : rang ≥ 3 → L3 / ADMIN.

## Contrôleurs

| Route | Méthode(s) | Accès | Rôle exigé | Notes / enforcement |
|---|---|---|---|---|
| `/api/health` | GET | Public | — | sonde |
| `/api/public/auth-config` | GET | Public | — | clé SITE Turnstile + flags OAuth/self-registration — **jamais de secret** |
| `/api/public/products` | GET | Public | — | catalogue hors DRAFT/DISABLED (`findPublicCatalog`) |
| `/api/checkout/intent` | POST | Public | — | rate limit 20/min/IP ; produit ordonnable sinon 404 |
| `/api/client/knowledge` | GET | Public | — | audience CLIENT + statut PUBLISHED ; liste SANS `body` |
| `/api/client/knowledge/categories` | GET | Public | — | catégories distinctes (CLIENT + PUBLISHED) |
| `/api/client/knowledge/:idOrSlug` | GET | Public | — | CLIENT + PUBLISHED, par id ou slug ; sinon 404 |
| `/api/auth/*` | POST | Public (sauf indiqué) | — | login : rate limit 10/min + Turnstile si activé ; register : rate limit 5/min + **checkout intent requis** ; `impersonate/return` et `change-password` : Auth |
| `/api/auth/mfa/*` | POST | Auth | tout rôle | verify + email/send : rate limit 5/min ; challenge single-use 300 s, 5 essais |
| `/api/auth/oauth/:provider` + `/callback` | GET | Public | — | state cookie 10 min ; fournisseur refusé si désactivé / clés absentes |
| `/api/products` | GET | Auth | tout rôle | liste **tous** statuts (page admin) |
| `/api/products` | POST | Auth | ADMIN | création + audit |
| `/api/products/:id` | PATCH / DELETE | Auth | ADMIN | PATCH audit ; DELETE refusé (409) si référencé par une souscription |
| `/api/users/me` | GET | Auth | tout rôle | profil — jamais `passwordHash`/`mfaSecretEnc`/`githubTokenEnc` |
| `/api/users` | GET | Auth | ADMIN | liste des comptes |
| `/api/users/:id` | PATCH | Auth | ADMIN | rôle + `isActive` ; gardes anti-verrouillage (dernier ADMIN) |
| `/api/users/:id/impersonate` | POST | Auth | ADMIN | jeton rôle USER figé + `imp`, sans refresh, audit |
| `/api/users/:id/mfa-reset` | POST | Auth | ADMIN | secours anti-verrouillage MFA |
| `/api/servers` | GET/POST/PATCH/DELETE | Auth | ADMIN | CRUD + sonde/vérif API |
| `/api/manager/summary` | GET | Auth | ADMIN | tableau de bord |
| `/api/audit` | GET | Auth | ADMIN | journal |
| `/api/invitations` | GET/POST/DELETE | Auth | ADMIN | invitations |
| `/api/admin/subscriptions` · `/api/admin/services` | GET / PATCH | Auth | ADMIN | approbation/suspension + affectation serveur |
| `/api/admin/mail` | GET / PUT | Auth | ADMIN | singleton mail (password chiffré, jamais renvoyé) |
| `/api/admin/security` | GET / PUT | Auth | ADMIN | flags sécurité + clés Turnstile (secret chiffré, jamais renvoyé) |
| `/api/client/subscriptions` | GET / POST | Auth | tout rôle | mes souscriptions + souscrire (produit ACTIVE/SUSPENDED) |
| `/api/client/subscriptions/:id/cancel` | POST | Auth | tout rôle (propriétaire) | annulation |
| `/api/client/services` | GET / POST | Auth | tout rôle | demander un service (souscription ACTIVE) |
| `/api/client/support-code` | GET / POST / DELETE | Auth | USER | générer/statut/révoquer ; 1 seul actif, TTL, affiché une fois |
| `/api/support/access` | POST | Auth | SUPPORT_L2+ | code 6 chiffres → impersonation **lecture seule** ; rate limit 10/min + Turnstile si activé |
| `/api/tickets` | GET / POST | Auth | USER | « mes tickets » + ouverture |
| `/api/tickets/:id` | GET | Auth | USER | propriétaire **ou** support ≥ L1 (vérifié dans le service via `roleRank`) |
| `/api/tickets/:id/messages` | POST | Auth | USER | propriétaire **ou** support ≥ L1 ; impersonation = lecture seule |
| `/api/tickets/:id/escalate` | POST | Auth | SUPPORT_L1+ | escalade L2/L3 |
| `/api/tickets/:id/status` | PATCH | Auth | SUPPORT_L1+ | changement de statut |
| `/api/support/tickets` | GET | Auth | SUPPORT_L1+ | file support complète |
| `/api/knowledge` | GET/POST/PUT/DELETE | Auth | ADMIN | CRUD des **deux** audiences (ADMIN + CLIENT), tout statut |

## Base de connaissance — séparation stricte (Phase 11)

Vérifiée sur le code (`knowledge.service.ts`, `knowledge.controller.ts`) :

1. Le client ne voit **jamais** un article interne ADMIN : les lectures publiques
   filtrent `audience = CLIENT` **et** `status = PUBLISHED`.
2. Un brouillon / article archivé CLIENT n’est **jamais** servi : le filtre statut
   est appliqué dans la requête (pas seulement côté web).
3. La liste publique ne renvoie **pas** `body` (économie + non-exposition).
4. Le détail public est résolu par id **ou** slug mais reste borné
   CLIENT + PUBLISHED → impossible de « deviner » un id ADMIN.
5. L’admin (et lui seul) voit les brouillons et la base interne via
   `/api/knowledge` (guard `@Roles(ADMIN)`).
6. Le `/aide` est **public** (centre d’aide, SEO) — c’est un choix assumé ; seuls
   les articles CLIENT + PUBLISHED y sont servis.

## Règles transverses

- **Impersonation** : le JWT d’impersonation a `role: USER` inscrit à la
  signature → il ne satisfait aucun `@Roles(SUPPORT_*)` ni `@Roles(ADMIN)`
  (anti-escalade), même si la cible est promue après coup.
- **Sessions courtes** : un jeton d’impersonation n’émet aucun refresh token ni
  cookie → `POST /auth/refresh` ne peut jamais le prolonger.
- **Aucune route « USER » n’existe en écriture admin** ; toutes les mutations
  de ressources partagées sont ADMIN. Le support agit via tickets + accès
  lecture seule.
- **Secrets jamais renvoyés** : `passwordHash`, `mfaSecretEnc`, `githubTokenEnc`,
  `turnstileSecretEnc`, `passwordEnc` (mail) sont exclus des réponses.
