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
      ou dans un document versionné). *La VM de test 172.20.116.6 (GO 12/10) n'est PAS ce
      VPS.*
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
- [ ] Provisioning **réel** (serveur hébergement réel) — **jamais fait** au sens : aucune
      validation d'intégration Coolify sur VPS dédié ; la VM de test 12/10 prouve le
      packaging Docker **sans Coolify installée** (catégorie infrastructure simulée).
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
