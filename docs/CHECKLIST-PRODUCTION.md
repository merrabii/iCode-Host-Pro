# Checklist — préparation à la production (GO clôture §9, C9.2)

> **Statut :** préparation, **pas** une autorisation de mise en production.
> Chaque case est à cocher **uniquement** après décision explicite du propriétaire, avec
> **preuve datée identifiable** (commande + sortie, journal, capture) — jamais « en théorie ».
> **Marque :** Code Diali (publique) · **Entité :** Code Diali LLC. **Prestataire :**
> Stripe **déjà choisi** (mode test actuellement) ; PaymentCloud éventuellement **ultérieur**
> (option, GO distinct). **Simulation ≠ Stripe test ≠ activation live** : jamais confondus.
> **Version de référence :** **`463f0146`** (commité, poussé, CI SUCCESS run `38145740652` ;
> contient l'intégralité des corrections paiements).
> Plan détaillé (sources fichier:ligne) : **`docs/PLAN-DEPLOIEMENT-CODE-DIALI.md`** (révision
> fiabilisation 11/10/2026 — tables de configuration refaites depuis le code).
> **État recette (11/10/2026)** : worktree recette aligné sur `463f0146`, API + Web servis
> depuis ce commit, contrôles santé/connexion/affichages OK — voir `recette/ETAT-REPRISE.md`.
>
> **Convention** : sections **A** = acquis prouvés (preuves identifiées) ·
> sections **B** = opérations **non exécutées** (à faire sur cible, jamais cochées d'avance).

---

# A. ACQUIS PROUVÉS (preuves identifiables)

## A1. Version et CI

- [x] **Version de référence figée** : `463f0146` — **prouvé** : `origin/main` = ce SHA,
      fast-forward `78b51ce`→`463f0146` (13 commits), arbre propre.
- [x] **CI GitHub VERT sur ce SHA** — **prouvé** : run `38145740652`, 18/18 étapes, aucune
      ignorée (typechecks, builds de contrôle, unit, e2e base CI isolée, suites legacy).
- [x] **Migrations du commit comptées** : **66** (dossiers `apps/api/prisma/migrations/`,
      noms identiques à ceux de la base recette — Compare-Object vide, 11/10).
      *Toute occurrence « 64 migrations » dans d'anciens documents est périmée.*
- [x] **Recette alignée et contrôlée** sur ce SHA (health 200, connexion fixture, affichages,
      0 mutation) — preuves : `recette/controle-alignement-checks.json`, captures
      `recette/aligne-01…06-*.png`, `recette/ETAT-REPRISE.md`.
- [x] **Packaging de premier déploiement livré + validé** (GO 12/10, catégorie
      **infrastructure simulée** — Docker sur VM de test locale 172.20.116.6, pas la prod) :
      images API/Web (`deploy/docker/*.Dockerfile`), compose `code-diali` (volumes `cdiali_*`,
      gates OFF, jobs `ops`), migration protégée (**66 migrations** appliquées sur base dédiée
      + **refus prouvé exit 3** sur cible inattendue), sauvegarde (177 717 o + fichiers,
      SHA-256, mode 0600) puis **restauration complète RESTORE_OK** dans une 2e base dédiée
      (empreintes revérifiées, rapprochement lecture seule), **persistance après stop+up**
      (login 201, fichier synthétique toujours présent), gates **exit 1 → désactivation →
      exit 0**, seed admin idempotent (`Admin ensured`) + login **201**.
      Preuves : `recette/ETAT-REPRISE.md` (jalon GO 12/10) + archive
      `REVUE-PREPARATION-DEPLOIEMENT.zip` (Bureau).
      **Corrections révélées par cette validation** : `start:prod` (`dist/src/main.js`),
      `pnpm exec prisma generate` (sans `exec` : silencieux), `openssl` builder,
      `postgresql-client-16` (client 15 refuse un serveur 16), strip `?schema=public` pour
      pg_dump, scripts sans BOM, `package.json` requis dans l'image runtime seed.

## A2. Connaissances de configuration (vérifiées dans le code, 11/10)

- [x] Variables **requises au boot API** : `DATABASE_URL`, `PORT`, `JWT_SECRET`
      (`apps/api/src/config/configuration.ts:145-153`).
- [x] `ENCRYPTION_KEY` = clé maître de **tous** les secrets chiffrés en base (SMTP, token
      DNS Cloudflare, clés Stripe, serveurs, OAuth, MFA) — `crypto.service.ts` ; sans elle,
      une base restaurée est **illisible** côté secrets.
- [x] Stripe, SMTP et DNS Cloudflare se configurent **en base via l'interface admin**
      (chiffrés) — **aucune** variable `STRIPE_*`/`SMTP_*`/`CLOUDFLARE_*` n'existe dans le
      code (vérifié sur 454 fichiers source).
- [x] Simulateur de paiements : `PAYMENT_SIMULATOR_ENABLED=true` **et**
      `NODE_ENV !== 'production'` ; **refus dur en production** même si l'env est `true`
      (`payment-provider.service.ts:404-406`).
- [x] Gates paiements (base, singleton `PaymentSettings`) : `walletPaymentEnabled` (défaut
      true), `cardOrderPaymentEnabled` (défaut **false**), `cardTopupEnabled` (défaut true) ;
      `assertEnabled()` → 409 `PAYMENT_METHOD_DISABLED`.
- [x] Sweeps OFF par défaut : `ORDER_SWEEP_ENABLED` / `RENEWAL_SWEEP_ENABLED` (actifs
      uniquement si `'true'` exact) ; réconciliateur **déploiements** `RECONCILE_ENABLED`
      défaut **false** (30 s de scan par défaut) — **variables `RECOMMANDED_ENABLED`,
      `ORDER_SWEEP=true` par défaut, etc. : inexistantes ou fausses, retirées du plan**.
- [x] Web : `API_UPSTREAM` **figé au build** (rewrite `/api/*`) ; `NEXT_PUBLIC_API_URL` =
      seule variable navigateur (branding) — `next.config.mjs`, `brand-provider.tsx`.
- [x] Création admin prod : **seed ADR-017** (`pnpm -C apps/api db:seed`,
      `ADMIN_EMAIL`/`ADMIN_PASSWORD` fournies **localement au moment du seed**, idempotent,
      ne réinitialise jamais un mot de passe) — **jamais de fixture de recette en prod**.
- [x] Parcours **virement** : **existant** (justificatif → validation admin ;
      `WalletTransaction.proofPath`, UI portefeuille + `/manager/recharges`) — indépendant
      de Stripe. Exercice complet : non revendiqué (voir B7).
- [x] Incident migrations **préservé et documenté** : `docs/DOSSIER-INCIDENT-MIGRATIONS.md`
      (restauration complète jamais présentée comme démontrée ; garde bloquante motivée).

## A3. Préproduction réelle — GO 13/10 + GO V2 14/10 + GO V3 15/10/2026 (VM dédiée 172.31.47.238, Coolify 4.4.6)

> **Catégorie : cible de test dédiée (préproduction), PAS la production.** Rapport unique :
> `recette/RAPPORT-GO-PREPRODUCTION.md` (V3, final, rectifie V1/V2) ; journal : `recette/ETAT-REPRISE.md`
> ; archive `REVUE-PREPRODUCTION-CODE-DIALI-V3.zip` (Bureau, final). Branche dediee poussee ; **aucun merge/push de main, aucune activation**.
> aucune activation.

- [x] **Intégration Coolify RÉELLE validée** (annule le « jamais fait » antérieur pour la
      préproduction) : app dockercompose liée à git, SHA épinglé `dc747bc…`, projet isolé,
      proxy Coolify « Custom (None) » (apache2:80 préservé), déploiements #5/#6/#8 DONE.
- [x] **Migration protégée sur préprod** : `migrate-guarded.sh` → `MIGRATE_EXIT=0`,
      **66 migrations**, base vierge confirmée avant.
- [x] **Gates premiers pas** : NON CONFORME initial (`cardTopupEnabled=true`, défaut de
      migration) → remédiation par l'**API admin** (voie sanctionnée) → **CONFORME** ;
      re-CONFORME après le deploy final.
- [x] **Seed admin réel** (`Admin ensured`, ADR-017, credentials hors fixture) + login
      **201** ; 1 user.
- [x] **Santé + catalogue + paiements** : health 200 `database ok`, web 200 marque « Code
      Diali », `/api/public/products` 200, `payment-capabilities` **tous false**.
- [x] **Redémarrage contrôlé** de la stack préprod → persistance + login OK.
- [x] **Sauvegarde + restauration sur préprod** : dump 178 123 o (SHA-256, 0600) →
      restauration `RESTORE_EXIT=0` vers base **neuve** `cd_preprod_restore`
      (**59 tables / 1 user = live**), source préservée.
- [x] **Consultation navigateur validée via TUNNEL SSH temporaire (127.0.0.1:13000) —
      15/15 PASS** (V1) : vrai formulaire login → `/manager`, cookie `ihp_refresh`
      httpOnly+Secure+Lax, refresh **201**, 14 appels API 2xx, 0 5xx, 0 requête hors
      tunnel, 0 URL morte, `/api/brand` 200. Preuves : `recette/tunnel/` + procédure
      `recette/ouvrir-tunnel-preprod.ps1`.
- [x] **Accès LAN direct `3211`/`3212` = BLOQUÉ** (V1, limitation Coolify 4.4.6 dockercompose+
      git sans commit) — signalé BLOQUÉ, jamais PASS.
- [x] **Accès direct HTTPS sans tunnel — PASS 14/14** (GO V2) : reverse proxy Caddy dédié
      hors Coolify (`preprod-proxy`), host 3212→80 + 3443→443 (cert auto-signé SAN IP),
      `reverse_proxy web:3000` par DNS Docker ; envs Coolify alignés HTTPS via API
      supportée (DELETE+POST) ; split SSR/client (delta `brand-data.ts` préparé, patch
      bundle temporaire, fix = git push) ; login UI → `/manager`, cookie Secure+httpOnly+Lax
      domaine `172.31.47.238`, refresh 201, rechargement session maintenue, 20 API 2xx,
      0 5xx, 0 hôte étranger, branding SSR réel. Preuves : `recette/direct/` + 6 captures.
- [x] **Interventions Coolify internes documentées** (GO V2) : parsers.php patch toujours
      actif (non retiré — retrait = commit git interdit), psql chiffré remplacé par
      DELETE+POST API supportée, remplacements supportés identifiés. ETAT-REPRISE §GO V2.
- [x] **Redéploiement contrôlé post-V2 sans tunnel ni réapplication parsers.php** :
      `force_rebuild` → nouvelles conteneurs `…20261014T091551`, accès revérifié 14/14.
- [x] **Gates paiements préservés après V2** : `payment-methods` = `[]`, `simulate-payment`
      = 400 (refus attendu).

- [x] **Fix SSR durable (V3)** : `brand-data.ts` commit+pousse (`4b18d83`) - SSR resout
      `http://api:3001` via `API_UPSTREAM`, **aucun patch temporaire conteneur**.
- [x] **Compose Coolify-compatible (V3)** : plus aucun `${VAR:?}` ; refus dans `preflight.sh`
      + scripts ops.
- [x] **Deploiement SANS parsers.php patch (V3)** : parsers.php original (md5 = backup) ->
      `POST start` -> finished, conteneurs `...20261015T032516`, HTTPS 200 - le patch interne
      Coolify **nest plus requis**.
- [x] **Branche dediee poussee (V3)** : `feat/preprod-reproductible-v3` = `4b18d83`, 0/0,
      arbre propre ; `main` = `dc747bc` **non merge, non poussee de nouvelle valeur**.
- [x] **Acces direct 14/14 post-V3** : reverifie apres re-deploy sans patch
      (`recette/direct/verify.json`).

## A4. Reprise GO V4 sur nouvelle VM — suites livrées (GO 15/10 + mesures du 18/10/2026)

> Nouvelle VM Ubuntu dédiée (l'ancienne a planté). Cible courante : **`172.17.79.197`**
> (changement d'IP en cours de lot après la cible initiale `172.17.66.79` ; les anciennes
> IPs de l'historique restent telles quelles dans les sections antérieures).

- [x] **Accès direct HTTPS rétabli sur la nouvelle IP** : `https://172.17.79.197:3443` → 200
      et `/api/health` = `{"status":"ok","database":"ok"}` ; `http://172.17.79.197:3212` → 200.
- [x] **Certificat régénéré pour la nouvelle IP** : CN=`172.17.79.197`, SHA-256
      `60:34:26:31:6F:8A:44:9B:74:E2:92:67:77:55:84:55:EA:A5:9A:07:CC:6A:E1:E7:E5:DB:DF:77:25:8E:CF:8E`
      ; **import manuel côté utilisateur** requis (procédure fournie, aucune installation
      silencieuse — la confiance navigateur reste une limite assumée).
- [x] **Envs actifs alignés** : `PUBLIC_BASE_URL`, `WEB_ORIGIN`, `PUBLIC_API_BASE`,
      `NEXT_PUBLIC_API_URL` = `https://172.17.79.197:3443` (backup `deploy/.env.bak-20261018`).
- [x] **Correctif durable des volumes (incident 18/10)** : clés `cdiali_pg/storage/branding`
      → `cdiali-pg/storage/branding` dans le compose runtime + compose ops + README ;
      validé `docker compose config` (local + VM) puis **commit `6f852b1` poussé** ;
      **CI SUCCESS** sur ce SHA (run `39122461784`, 18/10).
- [x] **Gardes — tests négatifs réels** : N1 `up` sans `JWT_SECRET` → exit 1 ; N2 `migrate`
      avec `EXPECTED_DB_NAME` faux → **exit 3** (refus identité SQL, 0 backup, 0 migration) ;
      N3 `BACKUP_HOST_DIR=/nonexistent` → exit 1 ; N4 `RESTORE_MANIFEST` vide → exit 1 ;
      N5 entrées invalides → exit 2/2 ; volumes live inchangés ; aucun résidu guardtest.
      Preuves : `recette/logs/gardes-negatifs-20261018.txt` + analyse
      `recette/logs/incident-n2-reconciliation-20261018.md`.
- [x] **Branding SSR avec valeur distincte puis restauration** : marqueur
      `SSR-MARQUEUR-20261018` rendu dans `<title>` **côté serveur** (curl sans JS) puis
      restauration explicite (PATCH valeurs initiales) vérifiée API + HTML.
      Preuve : `recette/branding/ssr-branding-20261018.txt`.
- [x] **Accès direct navigateur — 14/14 PASS sur la nouvelle IP**
      (`recette/direct/verify.json` + 6 captures ; `verify-direct.mjs` adapté
      `CDP_BASE` + host dynamique).
- [x] **Patch complet UTF-8 sans BOM applicable et fidèle à HEAD** :
      `recette/delta-dc747bc-a-6f852b1.patch` (113 455 o, 16 fichiers, +914/−148) ;
      `git apply --check` = **0** sur worktree `dc747bc`.
- [x] **État CI identifié précisément** : 4/4 runs de la branche `feat/**` = `success`
      (dernier : `6f852b1`, run `39122461784` le 18/10/2026) — lecture via API GitHub
      (`gh` absent).
- [x] **Incident réseau documenté et réparé** : pendant N2, un `docker compose run` du
      chemin ops a **réconcilié** les conteneurs db/preflight Coolify (dérive de labels
      `working_dir` panel vs ops) → db basculée sur le réseau `_default` → API `degraded`
      ~13 min ; réparé sans recréation (`docker network connect --alias db`), données
      intactes (66 migrations, 59 tables). **Risque résiduel** : divergence d'ownership
      panel/ops — correctif durable **proposé, à décider** (voir le rapport V4).

---

# B. OPÉRATIONS NON EXÉCUTÉES (à faire sur cible — cases vides volontairement)

> **État 12/10 (GO packaging)** : l'**outillage** de B2/B4/B5/B6 existe désormais
> (`deploy/` : Dockerfiles, compose, migration protégée, backup/restore, contrôle des
> gates) et a été **exercé avec succès sur une VM de test locale dédiée**
> (172.20.116.6 — Docker, bases dédiées, **pas la production**, **pas** une validation
> d'intégration Coolify). Les cases ci-dessous restent **vides** : elles concernent la
> **cible de production réelle** (VPS, domaine, secrets, Stripe/SMTP/DNS, validation
> Coolify, décisions owner). Les preuves locales sont en section A + archive
> `REVUE-PREPARATION-DEPLOIEMENT.zip`.

## B1. Cible et accès

- [ ] **VPS dédié identifié** (séparé des serveurs d'apps clients — CLAUDE.md §3) :
      accès SSH configuré **localement en sécurité** (jamais de mot de passe dans le chat
      ou dans un document versionné). *Les VMs de test 172.20.116.6 (GO 12/10) et
      172.31.47.238 (préproduction GO 13/10) ne sont PAS ce VPS.*
- [ ] **Domaine public** décidé ; DNS pointant vers le VPS ; HTTPS opérationnel
      (**autorité unique = le projet Coolify isolé** — décision GO ; `deploy/README.md`
      explique le retrait des `ports:` de validation au profit des routes Coolify).

## B2. Artefacts

- [ ] **Origine des artefacts de prod décidée** : construction contrôlée sur cible —
      **outillage prêt et prouvé** : `docker compose build api web` depuis un arbre
      `git checkout <SHA>` (PASS sur VM 12/10 : images 1,2 Go + 1,3 Go, zéro erreur) ;
      la CI actuelle **ne publie aucun artefact** (vérifié `ci.yml`) ; publication CI =
      chantier optionnel à développer.
- [ ] Artefact déployé = **SHA autorisé** (tag annoté créé/poussé après autorisation).

## B3. Configuration et secrets (production)

- [ ] `.env` de prod créé sur la cible (mode `077`, hors Git) : `DATABASE_URL` (base
      **neuve**), `PORT`, `JWT_SECRET` **neuve**, `ENCRYPTION_KEY` **neuve et conservée**
      (coffre hors VPS — perte = secrets en base illisibles), `PUBLIC_BASE_URL`,
      `WEB_ORIGIN`, `NEXT_PUBLIC_API_URL` = domaine public.
- [ ] Flags laissés **OFF** au premier démarrage (C2/C3/C4, sweeps, réconciliateur) sauf
      décision explicite documentée.
- [ ] `NODE_ENV=production` (coupe/refuse le simulateur — double protection vérifiée).
- [ ] Stripe : **catégorie B** = compte **test** créé, clés saisies via
      `/manager/moyens-paiement` (en base, chiffrées) ; webhook `whsec_` + URL publique
      HTTPS + **corps brut** préservé par le reverse proxy. Tant que non fait :
      **`cardOrderPaymentEnabled` reste false**, aucune clé configurée → parcours carte
      indisponibles (gate serveur).
- [ ] SMTP de prod saisi via `/manager/mail` ; token Cloudflare via `/manager/dns` ;
      Turnstile : `TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY` en env API + activation admin.
- [ ] Aucun secret dans le dépôt : `git grep` préfixes `sk_`/`whsec_`/`postgres://` → 0 hit
      hors exemples.

## B4. Migrations (jamais exécutées jusqu'à présent sur prod)

- [ ] **Sauvegarde complète** de la base cible **avant** toute migration (pg_dump horodaté,
      sortie vérifiée, stockage **hors VPS**) — **automatisée et prouvée** par
      `deploy/scripts/migrate-guarded.sh` (backup préalable si tables présentes,
      `pg_restore --list` exigé ; pg_dump **16** obligatoire — le client 15 refuse un
      serveur 16).
- [ ] **Garde bloquante** opérationnelle — **livrée et prouvée** :
      `deploy/scripts/migrate-guarded.sh` (URL obligatoire sans repli, identité SQL
      `current_database()` + `inet_server_addr()` résolu + port sur la **même connexion**,
      refus **exit 3 avant toute mutation** — preuve VM 12/10 : cible inattendue refusée,
      66 migrations appliquées sur cible attendue). Modèle antérieur : `recette/db-guard.mjs`.
- [ ] `prisma migrate deploy` (66 migrations attendues sur `463f0146` ; **jamais**
      `migrate dev` en prod).
- [ ] `prisma migrate status` = up to date **après** déploiement (preuve jointe).

## B5. Sauvegarde / restauration (outillage livré — planification prod à faire)

- [ ] Automatisation de sauvegarde quotidienne **avec détection d'échec** (code retour,
      taille, alerte) + rétention décidée + stockage hors cible — **script livré et prouvé**
      (`deploy/scripts/backup.sh` : exit bruyant, `pg_restore --list`, SHA-256, mode 0600 ;
      exercice VM 12/10 : dump 177 717 o + archive fichiers, BACKUP_OK) ; **planifier**
      la périodicité + le stockage de PROD (case vide tant que non décidé).
- [ ] **Exercice de restauration** sur base isolée, exécuté et tracé — **sans suppression
      automatique** (laisser pour revue ; suppression = instruction explicite) — **prouvé**
      sur la VM 12/10 (`restore.sh` : empreintes revérifiées, refus exit 3 sur base non
      vierge, RESTORE_OK avec rapprochement lecture seule dans `code_diali_restore`) ;
      **à refaire sur la base de prod** avec ses propres données.
- [ ] Vérification de la **lisibilité des secrets** restaurés avec la `ENCRYPTION_KEY` de
      prod (sinon : restauration inutilisable — constat explicite) — **NON TESTÉ** (la VM
      utilisait une clé synthétique locale ; la clé de prod n'existe pas encore).
- [ ] **RPO/RTO décidés** (proposition : RPO 24 h / RTO ~2 h — à valider) et mesurés après
      le premier exercice (exercice local VM 12/10 : restauration complète ≈ 1 min —
      mesure locale, **aucune garantie production**).
- [ ] Procédure de **suspension contrôlée** écrite et validée avant toute restauration
      réelle : retirer le domaine, arrêter API/Web (les timers de sweep meurent avec le
      processus), exporter l'état courant des tables financières (`CardPayment`, `Refund`,
      `RefundObservation`, `WalletTransaction`, `PaymentWebhookEvent`, `Order`) **puis**
      restaurer ; **rapprochement paiements/remboursements/portefeuille/effets provider**
      (journal Stripe) avant toute réouverture ; intervention admin tracée pour tout
      écart. *Le rapprochement lecture seule est intégré à `restore.sh` ; la suspension
      réseau (retrait du domaine) reste manuelle/opérateur.*

## B6. Mise en service et supervision

- [ ] **Superviseur choisi** [D] — dans le parcours retenu, **Coolify est le superviseur
      des conteneurs** (pas de systemd/PM2 en parallèle — décision GO) ; aucune unité
      systemd n'est fournie ni requise. Démarrage manuel de secours documenté :
      `node apps/api/dist/src/main.js` + `next start` (chemin `start:prod` **corrigé** le
      12/10 dans `apps/api/package.json`).
- [ ] **Pas de rolling update** : la procédure de mise à jour est **arrêt → reconstruction
      des images → redémarrage** (`deploy/README.md` — aucun git checkout/rebuild dans le
      répertoire d'un service actif).
- [ ] Santé vérifiée sur cible : `/api/health` 200 + `database ok` ; Web 200 ; brand
      « Code Diali » ; **login admin créé par le seed** (pas une fixture) — **prouvé sur
      VM 12/10** (health 200/200, login seed **201**, persistance après stop+up) ;
      **à reproduire sur le VPS de prod**.
- [ ] Alertes minimales (erreur webhook 5xx, `UNCERTAIN`/`NEEDS_REVIEW` persistants, disque,
      process) ; logs ≥ 30 jours. **Aucune alerte configurée** (case vide).

## B7. Essais réels et décisions

- [ ] **Catégorie B** : essais Stripe **test** (recharge + règlement commande + webhook
      réel + remboursement) selon `docs/GUIDE-STRIPE-TEST.md` — **bloqué** tant que le
      compte test n'existe pas.
- [ ] Parcours **virement** (justificatif → validation admin) exécuté de bout en bout en
      recette (statut actuel : implémenté, exercice complet **non revendiqué**).
- [x] **Validation d'intégration Coolify** : **acquise sur préproduction** (GO 13/10, VM
      172.31.47.238 — Coolify 4.4.6, app dockercompose @SHA, migrate/gates/seed/backup/
      restore/tunnel navigateur 15/15, voir A3). **Restant** : validation sur le **VPS de
      production réel** (domaine, secrets, HTTPS) — case B1/B3 ; provisionning d'un serveur
      d'apps **client** réel = jamais fait (hors périmètre de ce GO).
- [ ] **Installateur web** + **commande serveur vierge** : à développer puis testés **en
      fin de projet** (CLAUDE.md §Rappel) — sur base neuve, jamais sur les bases clientes.
- [ ] Aucune opération déployée sur le/des serveur(s) d'apps clients ; `icode_host_pro`
      (dev) jamais touchée (incident migrations : `docs/DOSSIER-INCIDENT-MIGRATIONS.md`).
- [ ] Décisions socle restantes (GO §6) : provider live (§6-1), effet infra suspension
      (§6-4), numérotation annuelle (§6-6), RGPD + switch inscription (§6-7).
- [ ] Validation owner case par case.

---

## Procédure de retour arrière (rappel — applicatif ≠ données)

1. **Applicatif** : arrêt, redéploy du SHA précédent (arrêt/reconstruction/redémarrage),
   vérifications. **Aucune restauration de données** n'est liée à un simple retour
   applicatif.
2. **Données** (uniquement si corruption/perte avérée) : procédure complète B5
   (suspension → export état courant → restauration → rapprochement → réouverture).
3. **Jamais** de `migrate down` en prod sans sauvegarde validée + double validation.
4. Journaliser chaque incident (date, cause, état restauré, opérations rapprochées).

---

## Rappels permanents

- Marque publique **Code Diali** ; entité **Code Diali LLC** ; anciens noms uniquement
  dans les identifiants techniques existants.
- **Stripe déjà choisi** ; **PaymentCloud** éventuellement **ultérieur** (option).
- **Simulation ≠ Stripe test ≠ activation live.**
- Aucun commit/merge/push sans ordre explicite ; aucune migration sans garde bloquante +
  sauvegarde ; aucun paiement/call provider réel sans autorisation.
- `463f0146` **n'est pas** qualifié « prêt pour production » : essais B + validation
  cible restants.
