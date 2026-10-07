# RAPPORT — GO Stripe mode test (recharges par carte, webhooks signés, USD/EUR, remboursements/litiges, UI client + admin)

**Date :** 07/10/2026 · **Branche :** `feat/stripe-test` (worktree principal `C:\Users\mourad.errabii\Documents\Projet iCode Host`) · **Base de départ :** `main` @ `78b51ce`
**Commits de code :** `d97d39c` (feature), `650906a` (correctif UI), `e7374ee` (correctif pagination), **`209de8f` (GO2 — corrections P1→P8 de la revue)** — **+ des commits documentaires (liste exacte : `git log 78b51ce..HEAD`)** — **aucun push, aucun merge** (`main`/`origin/main` = `78b51ce` intact ; `feat/socle-commercial` = `5555566` intact ; `feat/stripe-test` n'existe que localement).
**Worktree de recette :** `C:\Users\mourad.errabii\Documents\iCode-Host-Recette` détaché sur **`e7374ee`**, **stack laissée en fonctionnement** (web 3002, API 3011, proxy 3999, simulateurs 302x) ; scripts `recette/down.ps1` / `recette/up-p10.ps1` inchangés.
**Bases :** `icode_host_pro_socle` **63 migrations** (e2e), `icode_host_pro_recette` **63** (parcours navigateur catégorie C + migration GO2), `icode_host_pro_c3premig` / `_c4premig` / `_c4test` (suites legacy), `icode_host_pro` (dev local) **60/63 — les 3 migrations Stripe volontairement NON appliquées** (décision du GO : migrations uniquement sur bases isolées ; `prisma migrate status` le signale).
**Environnement de preuve :** local uniquement — **aucune clé Stripe réelle, aucun appel réseau sortant vers Stripe** (recette = connecteur `simulated`), **aucune mise en production, aucun chiffre d'argent réel**.
**Patch de revue :** **deux** patches écrits par Git lui-même (hors git) : `recette/diff-stripe-test.patch` (global, `git diff 78b51ce <HEAD> --binary --full-index`) et `recette/diff-go2-corrections.patch` (corrections seules, `git diff 41f44eb <HEAD> --binary --full-index`) ; **statistiques exactes et SHA-256 dans `recette/GUIDE-RECETTE-STRIPE.md`** (hors git — les hashes sont calculés **après le dernier commit, sans aucun commit de cachet**).

---

## 1. Synthèse par capacité (statut · preuve · limite)

Statuts GO : **terminée / partielle / bloquée / non testée**. Aucun « PASS global » : chaque ligne porte sa preuve et sa limite.

| # | Capacité | Statut | Preuve principale | Limite / réserve |
|---|---|---|---|---|
| 1 | Modèle et persistance (§1) : `PaymentProviderSetting`, `CardPayment`, `PaymentWebhookEvent`, `Customer.walletCurrency`, `Refund.cardPaymentId`, `WalletTransaction.disputedAt` | **terminée** | 3 migrations additives `20261007000001_stripe_card_payments` (149 lignes) + `20261007000002_refund_card_payment_index` + **`20261007000003_go_p1_p8_corrections` (GO2)** ; `prisma migrate status` = up to date (**63**) sur `icode_host_pro_socle` et `icode_host_pro_recette` | `icode_host_pro` (dev local) reste à **60/63** et les 3 bases legacy à **62/63** (la migration GO2 n'apporte rien aux suites legacy, qui ne touchent pas ces colonnes) — à migrer avant tout usage dev de la fonction |
| 2 | Configuration connecteur admin (§2) : saisie des clés **mode test uniquement**, stockage chiffré | **terminée** | PUT `provider` : préfixes imposés `sk_test_` / `pk_test_` / `whsec_`, activation refusée sans `sk_test_`, `environment` **`@IsIn(['test'])`** ; secrets AES-256-GCM (`CryptoService`/`ENCRYPTION_KEY`) **écriture seule** : `hasSecretKey`/`hasWebhookSecret` exposés, jamais la valeur ; parcours `secrets-ecrits-seuls-ui` + `secrets-ecrits-seuls-api` (sk/whsec absents du HTML **et** du JSON) | Clés réelles = catégorie B (§6) |
| 3 | Contrôle de connexion | **terminée** | `POST …/provider/check` → `lastCheckAt`/`lastCheckAccount`/`lastCheckError` persistés ; UI affiche « Contrôle de connexion ÉCHOUÉ : … » (correctif `650906a`) ; checks `b-controle-connexion-echec-visible` + `pas-de-ok-silencieux` | En recette le connecteur est `simulated` (Stripe actif + clé fictive → échec visible attendu) |
| 4 | Recharge par carte (§3) : création **côté serveur**, page hébergée, suivi | **terminée** | `POST /api/client/payments/topups` → référence `CDP-…` ; page hébergée sans champ de carte (`page-hebergee-sans-carte`) ; suivi `/client/portefeuille/paiement?ref=…` → « Payé à crédité » ; e2e `card-topup` **48/48** (dont le bloc **I — corrections GO2**) | Mode test/simulé uniquement |
| 5 | Webhook **signé** (§4) : corps brut, HMAC, idempotence, crédit atomique | **terminée** | `rawBody` activé au bootstrap ; `POST /api/payments/webhook` : **401** signature invalide, **503** secret absent, **400** corps brut absent, **200** traité/doublon, **500** échec → rejeu prestataire ; unicité `(providerCode, eventId)` ; **seul chemin de crédit** = confirmation serveur (trace `cardpay:<id>`, `PROCESSED`) ; checks `webhook-signature-obligatoire`, `confirmation-atomique-tracee`, `solde-credit-5000` ; **GO2** : identité source résolue **après** signature → type géré sans identité = **503** `provider_identity_unavailable` + ligne `FAILED`, type hors périmètre = **200 `IGNORED`** (e2e **E8**) | Signature Stripe testée **sans réseau** (unit `stripe-signature` 9/9) ; événements réels Stripe = catégorie B |
| 6 | Devises **USD/EUR sans somme ni FX** | **terminée** | DTO `@IsIn(['USD','EUR'])`, devise unique par recharge ; `Customer.walletCurrency` par compte ; e2e + parcours (50.00 USD → 5000 cents) | MAD exclu (décision GO) |
| 7 | Remboursements carte (§6) : plafond, idempotence, états | **terminée** | Plafond cumulé **≤ encaissé** (`refundCapExceeded`, message « Plafond de remboursement dépassé : encaissé … déjà engagé … demandé … »), reservations comptées ; `SUCCEEDED`/`PARTIALLY_REFUNDED`, `refundedCents` cumulés, trace `cardrefund:<id>` ; e2e `card-topup` (refus plafond + remboursement partiel 10.00) ; unit `card-refunds` **17/17** (**GO2** : annulation refusée après envoi + audit `refund.topup.cancel_refused`, remboursement interne idempotent, `usedCents` = encaissé − `pendingRefundCents`) | Remboursement **vers la carte** simulé en recette |
| 8 | Litiges (`charge.dispute.*`) | **terminée** | `charge.dispute.created/closed` → `WalletTransaction.disputedAt`, statut `needs_review`, aucun crédit ni débit implicite ; unit `payment-webhook` **17/17** (**GO2** : `refund.*`, reprise `topup:<ref>` avec `reconcileAt`/backoff, notice sans effet solde) | Recette : litiges injectés via webhook signé simulé, pas de dispute Stripe réelle |
| 9 | UI client (portefeuille, paiement, historique) | **terminée** | `/client/portefeuille` (+ carte recharge), `/client/portefeuille/paiement` (§7), historique avec référence `CDP-…` ; parcours `historique-client-reference`, `statut-signe-cote-serveur` | — |
| 10 | UI admin (§2/§6/§7) : configuration, liste, détail, remboursements, événements | **terminée** | `/manager/paiements-carte` (nav ajoutée) : config, alerte connecteur inactif, recherche par référence, panneau détail + plafond, remboursement, panneau événements webhook ; **2 correctifs GO** (§4 ci-dessous) | — |
| 11 | Mode **test strict**, **live refusé** | **terminée** | PUT `environment:'live'` → **400** (DTO `@IsIn(['test'])`) + garde `resolve()` « Configuration live refusée (GO Stripe) » ; check `d-activation-live-refusee` | Marche de sécurité = décision owner (§6) |
| 12 | **Catégorie B — Stripe réel (mode test du prestataire)** | **bloquée** | Check `b-aucune-cle-stripe-env` : **0 variable `STRIPE_*`** ; aucun compte ni clé Stripe dans cet environnement | Prérequis exacts : **§6** |
| 13 | **Catégorie D — production / activation live** | **bloquée** | Refus explicite du passage en live (ligne 11) ; `NODE_ENV=production` coupe le simulateur | GO distinct + décision propriétaire ; **jamais « production ready »** |

**Ce que la table ne prétend PAS :** aucune ligne ne couvre un appel réseau réel vers Stripe, une banque, une carte réelle, ni une mise en production.

---

## 2. Matrice de validation A / B / C / D

| Catégorie | Définition GO | Résultat | Preuve |
|---|---|---|---|
| **A — automatisée** | unit + e2e + typecheck + builds, exécutés sur HEAD | **PASS** | unit **1314/1314 (71 suites)** · e2e principal **583/583 (48 suites)** sur `icode_host_pro_socle` · legacy **39/39 (4 suites)** sur 3 bases dédiées → **e2e total 622/622 (52 suites)** · `tsc` API **0** · `tsc` web **0** · `nest build` **0** · `next build` **0** (heap 6144) — GO1 relancé après `e7374ee` (§3), **GO2 relancé après `209de8f`** (§9) |
| **B — Stripe réel** | clés de test du prestataire, compte Stripe, webhook réel | **BLOQUÉE** | aucune clé `STRIPE_*`, aucun compte Stripe ; **ne jamais présenter la simulation comme une validation Stripe réelle** (prérequis : §6) |
| **C — navigateur** | parcours réels dans un navigateur sur la recette | **PASS — 38/38 checks** | `recette/parcours-stripe.mjs` → `recette/stripe-checks.json` (38 checks, 0 échec, stamp `muxoqoo1`, 07/10/2026 05:48Z) + **13 captures** `recette/stripe-01…13-*.png` ; exécuté **3 fois** consécutivement (création fixture puis « existant + marqueur vérifié »), idempotent |
| **C-GO2 — navigateur (parcours P2)** | persistance de la clé de tentative dans le **worktree principal** (web 3003 + API 3001, base socle) | **PASS — 12/12 checks** | Edge headless CDP **sans proxy** → `go2-ui-check.mjs` : login `201`, formulaire carte, tentative 1 → clé `web-topup-…` + référence `CDP-…` persistées ; tentative 2 (même montant) → **même clé, même session `cs_sim_…`, même référence** ; montant différent → nouvelle clé/session ; **0 requête hors localhost** ; corroboration SQL `n500=1|n800=1` (une seule `CardPayment` par montant) ; base nettoyée après le test | Exécuté sur le simulateur local, pas de prestataire tiers |
| **D — production / live** | activation en production | **BLOQUÉE** | refus serveur du mode live (400 + garde `resolve()`), simulateur coupé sous `NODE_ENV=production` ; **aucune opération exécutée sur un serveur** |

**Détail des 38 checks (famille par famille)** : stack + garde `current_database()` · `b-aucune-cle-stripe-env` · `d-activation-live-refusee` · `webhook-signature-obligatoire` · simulateur autorisé · fixture dédiée `stripe-client@icode.test` (marqueur « Client Stripe GO (fixture dédiée », solde 0) · config enregistrée + **secrets écrits-seuls** (UI et API) · **contrôle de connexion en échec visible** + **aucun « OK » silencieux** · alerte connecteur inactif + retombée simulateur · recharge 50 USD → page hébergée (aucune donnée de carte) → redirection suivi → **« Payé à crédité »** → solde 0 → 5000 · crédit atomique tracé · historique client · recherche admin par référence → ouverture détail → plafond affiché · **refus de plafond** (solde inchangé, 0 remboursement) · **remboursement partiel 10.00** (`SUCCEEDED`, `refundedCents=1000`, `PARTIALLY_REFUNDED`, solde 5000→4000, trace `cardrefund:`) · badge « Remboursé partiellement » · **refus carte `#ko` → `FAILED`, aucun crédit** · panneau événements webhook (badge « Traité ») · **scan final sans secret** (`sk=false`, `whsec=false`).

---

## 3. Résultats finaux (commandes · bases · résultats · commit)

**Commit testé GO1 : `e7374ee`** (HEAD de code de l'époque) ; **commit testé GO2 : `209de8f`** (voir §9). Exécution GO1 **unique relancée intégralement le 07/10/2026 après le dernier commit** (les JSON antérieurs précédaient les deux correctifs) ; **batterie GO2 relancée intégralement après `209de8f`** :

| Étape | Commande (cwd) | Base | Résultat |
|---|---|---|---|
| Typecheck API | `npx tsc --noEmit -p tsconfig.json` (`apps/api`) | — | **EXIT 0** |
| Typecheck Web | `npx tsc --noEmit -p tsconfig.json` (`apps/web`) | — | **EXIT 0** |
| Build API | `npx nest build` (`apps/api`) | — | **EXIT 0** |
| Unit complet | `npx jest src --maxWorkers=4` (`apps/api`) | — | **1314/1314 PASS — 71 suites** (dont payments GO2 : `payment-provider` **15**, `card-payments` **19**, `card-refunds` **17**, `payment-webhook` **17**, `wallet` **30**, `stripe-signature` 9) |
| e2e principal | `npx jest --config ./test/jest-e2e.json --runInBand --testPathIgnorePatterns c3-premig c4-premig c4-release c4-rollback` | `icode_host_pro_socle` | **583/583 PASS — 48 suites** (dont `card-topup` **48/48**, bloc **I** = corrections GO2) |
| e2e legacy (4 suites) | idem + `DATABASE_URL` dédiée + `--testPathPattern` | `icode_host_pro_c3premig` / `_c4premig` / `_c4test` | **39/39 PASS** (3 + 3 + 33) |
| Build Web | `NODE_OPTIONS=--max-old-space-size=6144 npx next build` (`apps/web`) | — | **EXIT 0** |
| Lint | `pnpm run lint` | — | **non exécutable** (ESLint absent du workspace — préexistant ; équivalent = typechecks + builds verts) |
| Parcours navigateur (cat. C, GO1) | `node recette/parcours-stripe.mjs` (worktree recette, stack `up-p10.ps1`) | `icode_host_pro_recette` | **38/38 PASS**, exit 0, 13 captures + `stripe-checks.json` |
| Parcours navigateur (C-GO2, P2) | `go2-ui-run.ps1` → `go2-ui-check.mjs` (Edge headless CDP, web 3003 + API 3001, simulateur activé) | `icode_host_pro_socle` | **12/12 PASS** + `DB_COUNTS n500=1\|n800=1`, exit 0, fixture créée puis nettoyée |

**Total e2e : 622/622 — 52 suites** (48 socle + 4 legacy). Aucune assertion affaiblie, aucun test supprimé ou ignoré : GO1 a **ajouté** des assertions (échec visible, liste admin paginée réellement interrogée), GO2 en a **ajouté 26** (bloc I e2e + 43 tests unitaires neufs/corrigés sur 5 specs).

---

## 4. Corrections livrées pendant le GO + constats résiduels

| # | Constat | Correction | Preuve | Commit |
|---|---|---|---|---|
| 1 | **Faux « OK » du contrôle de connexion** : la console admin affichait « Connexion stripe OK » alors que le contrôle avait échoué (connecteur simulé + clé fictive) | `checkProvider` distingue le résultat réel : « Contrôle de connexion ÉCHOUÉ : `<lastCheckError>` », sinon message explicite (simulateur), + ligne persistante « Dernier contrôle : <date> — échec/… » | checks `b-controle-connexion-echec-visible` + `pas-de-ok-silencieux` | `650906a` |
| 2 | **Liste admin toujours en erreur 400** : `AdminCardPaymentQueryDto` déclarait `page`/`perPage` sans `@Type(() => Number)` → query string stricte → **400 systématique** → l'UI affichait « Aucun paiement carte pour ce filtre. » (état vide trompeur) | `@Type(() => Number)` + `import { Type } from 'class-transformer'` ; e2e `card-topup` **H3 étendu** : `.query({ page: 1, perPage: 20, q: reference })` → **200** | `card-topup` 44/44 (avec la nouvelle assertion) | `e7374ee` |
| 3 | Outillage recette : le webhook affiché à l'admin pointait sur `localhost:3001` (défaut) alors que la recette tourne sur 3002 | variable `PUBLIC_API_BASE` ajoutée à `recette/up-p10.ps1` (`http://localhost:3002`), recalculée à chaque `save` | URL affichée = `/api/payments/webhook` joignable en 3002 | hors git (`recette/`) |

**Constats résiduels NON corrigés (volontairement, hors périmètre) :**
- `PaymentWebhookEvent.error` reçoit `outcome.note` (ex. « crédité CDP-… (5000) ») et s'affiche sous le badge : **cosmétique**, l'information est exacte mais dans la mauvaise colonne sémantique.
- `.badge` de la page hébergée force `text-transform: uppercase` (« SIMULATEUR LOCAL ») : le parcours lit `textContent`, donc rien n'est cassé côté produit.
- `icode_host_pro` (dev local) : 2 migrations Stripe en attente — **voulu** (bases isolées uniquement), à appliquer avant tout usage dev de la fonction.

---

## 5. Garde-fous de sécurité vérifiés (preuves)

1. **Secrets jamais exposés** : `secretKeyEnc`/`webhookSecretEnc` en AES-256-GCM ; GET/PUT ne renvoient que `hasSecretKey`/`hasWebhookSecret` ; parcours vérifie l'absence de `sk_`/`whsec_` dans le HTML **et** dans les réponses JSON, sur la page admin **et** sur la page finale.
2. **Seules des clés de test acceptées** : `sk_test_` / `pk_test_` / `whsec_` exigés à l'enregistrement ; activation refusée sans `sk_test_` ; `environment` **uniquement `'test'`**.
3. **Webhook** : corps **brut** (`rawBody`) pour le HMAC — jamais un corps re-serialisé ; **401** sur signature invalide, **503** si aucun secret configuré (refus net, jamais de « default OK »), **400** si le corps brut est absent.
4. **Idempotence** : `(providerCode, eventId)` unique → un rejeu prestataire n'écrit pas deux fois ; **une seule écriture de crédit** par confirmation (transaction, trace `cardpay:<id>`).
5. **Crédit uniquement serveur** : la page hébergée ne contient **aucun champ de carte** ; le solde ne bouge qu'après confirmation serveur authentifiée (parcours `solde-credit-5000`, `statut-signe-cote-serveur`).
6. **Bornes métier** : montant `100` → `10_000_000` cents (1,00 → 100 000,00), devise `USD`/`EUR` **une seule par opération**, plafond de remboursement cumulé ≤ encaissé (réservations incluses pour empêcher tout dépassement par reprise).
7. **Simulateur** : `PAYMENT_SIMULATOR_ENABLED === 'true'` **ET** `NODE_ENV !== 'production'` (lu à l'appel) ; sans connecteur résolu → **refus explicite** (pas de bouton de paiement décoratif).
8. **Aucun secret dans les livrables** : captures et JSON sans clé ; identifiants admin des scripts jetables **lus depuis** `recette/parcours-q10.mjs` (jamais dupliqués dans un nouveau fichier — règle du scan de sécurité).

---

## 6. Prérequis pour débloquer les catégories B et D (exacts — rien n'est présumé)

### B — **premier vrai appel Stripe en mode test** (non exécuté ici)
1. **Compte Stripe** créé en **mode test** (dashboard test) + **2 test cards** du prestataire.
2. **Clés** saisies dans `/manager/paiements-carte` (jamais en clair dans `.env`, jamais commitées) :
   - `secret key` **`sk_test_…`** (préfixe exigé),
   - `publishable key` **`pk_test_…`**,
   - **signing secret** du endpoint webhook **`whsec_…`**.
3. **`ENCRYPTION_KEY`** définie sur l'API (sinon l'enregistrement d'un secret est refusé à 400).
4. **Endpoint webhook joignable** : `PUBLIC_API_BASE` = URL **publique** de l'API ; enregistrer `POST /api/payments/webhook` dans Stripe avec les types gérés : `checkout.session.*`, `payment_intent.*`, `charge.refunded`, `charge.dispute.created/closed`.
5. **`PAYMENT_SIMULATOR_ENABLED`** retiré/false (le connecteur Stripe actif le prime, mais l'absence de flag évite toute ambiguïté de lecture).
6. **`STRIPE_API_BASE`** : laisser le défaut `https://api.stripe.com` (uniquement pour proxy/mock).
7. Rejouer la **catégorie C** (`recette/parcours-stripe.mjs`) **et** la batterie **A** contre ce compte, puis comparer les statuts Stripe réels — **rétro qualifier les lignes 4 à 8** (webhook, remboursement, litige) comme « testé réellement » **uniquement** sur cette preuve.

### D — **production / activation live** (délibérément refusée)
- `environment` n'accepte que `'test'` (DTO) et `resolve()` lève « Configuration live refusée (GO Stripe) » : la levée de cette marche est **une décision propriétaire** avec un GO dédié, qui devra prévoir : compte **live**, clés `sk_live_`, revue de sécurité (rotation `ENCRYPTION_KEY`, secrets, webhooks), bascule `NODE_ENV=production` (coupe le simulateur), sauvegarde/base de production distincte, procédure de rollback. **Ce rapport ne dit à aucun moment « prêt pour la production ».**

---

## 7. Guide de validation manuelle (rejeu par un humain)

1. **Prérequis** : Docker `icode-postgres` up ; worktree recette détaché sur le commit de code.
2. `recette\down.ps1` puis `recette\up-p10.ps1` (contrôler `GET http://localhost:3011/api/health` → 200 et `http://localhost:3002` → 200). Vérifier que `apps/api/dist` est **plus récent** que `src/*.ts`.
3. Ouvrir `http://localhost:3002/manager/paiements-carte` (admin `admin-recette@icode.test`) :
   - config enregistrée, **champ secret vide**, `hasSecretKey=true`, badges ;
   - « Tester la connexion » → **échec visible** (aucun « OK »), dernier contrôle daté ;
   - alimenter une clé `sk_test_…` factice → **« Contrôle de connexion ÉCHOUÉ »**.
4. Client `stripe-client@icode.test` → `/client/portefeuille` → « Recharger par carte » → montant **50.00 USD** → page hébergée (mention « aucune carte ») → `#ok` (succès) ou `#ko` (refus) → suivi → **solde +50.00** uniquement si `#ok`.
5. Admin → recherche par référence `CDP-…` → **Ouvrir** → tenter un remboursement **supérieur au plafond** (refus + solde inchangé) puis **10.00** (SUCCEEDED, `PARTIALLY_REFUNDED`, solde −10.00).
6. POST sans signature sur `/api/payments/webhook` → **401** (ou **503** si aucun secret) ; panneau « Événements webhook » → badge « Traité ».
7. Vérifier l'**absence de secret** dans la page source (Ctrl+U : aucun `sk_`/`whsec_`).
8. Rejouer automatisé : `node recette/parcours-stripe.mjs` → **38/38** ; résultats dans `recette/stripe-checks.json` + captures `recette/stripe-*.png`.
9. **Rejeu GO2 (P2 — idempotence de tentative)** : sur `http://localhost:3003` (web) + `:3001` (API, base socle, simulateur), soumettre **deux fois de suite** la même recharge carte → les deux parcours doivent ouvrir **la même session hébergée et la même référence `CDP-…`** (1 seule ligne en base : `SELECT count(*) FROM "CardPayment" WHERE "customerId" = …`), puis vérifier qu'un montant différent ouvre bien une nouvelle référence ; l'automatisation correspondante est `go2-ui-check.mjs` (12 checks).

---

## 8. Inventaires (commits · fichiers · migrations · patch)

- **Commits (3 de code GO1 + 1 de code GO2, le reste documentaire) — liste exacte `git log 78b51ce..HEAD` :**
  - `d97d39c` `feat(payments): Stripe test-mode card top-ups, signed webhooks, refunds and admin UI (GO Stripe)`
  - `650906a` `fix(web): display real connection-check outcome in Stripe admin (GO Stripe)`
  - `e7374ee` `fix(payments): coerce admin payment list pagination with @Type(Number) (GO Stripe)`
  - **`209de8f` `fix(payments): GO2 corrections P1-P8 - provider identity gate, persisted top-up attempt key, refund dispatch guards, wallet currency lock (GO Stripe)`**
  - + commits documentaires : `git log 78b51ce..HEAD` (rapport, HTML v14, statut)
- **Fichiers : 31** (`git diff --stat 78b51ce e7374ee` : **7 374 insertions / 14 suppressions**) — API : `payments/*` (services, connecteurs `stripe-connector`/`simulated-connector`, `stripe-signature`, 4 contrôleurs, DTO), `wallet.service.ts`, `store/refund.service.ts`, `app.module.ts` (`rawBody`), `main.ts`, `schema.prisma` + 2 migrations ; Web : `/manager/paiements-carte`, `/client/portefeuille/{page,paiement}`, `config/nav.ts`, `lib/api.ts` ; tests : `card-topup.e2e-spec.ts` + 4 specs unit.
- **GO2 : 20 fichiers** (`git diff --stat 41f44eb 209de8f` : **2 524 insertions / 295 suppressions**) — API : `payment-webhook.service`, `payment-provider.service` (+ spec neuve), `card-payments.service`, `card-refunds.service`, `payment-connector`, `stripe-connector`, `simulated-connector`, `simulated-payment.controller`, `wallet.service`, `schema.prisma` + migration ; Web : `lib/api.ts`, `portefeuille/page`, `portefeuille/paiement/page` ; tests : `card-topup.e2e-spec` (bloc I) + 5 specs.
- **Migrations : 3 additives** (60 → 63) : `20261007000001_stripe_card_payments`, `20261007000002_refund_card_payment_index`, **`20261007000003_go_p1_p8_corrections`** — appliquées **uniquement** sur `icode_host_pro_socle` et `icode_host_pro_recette` (**63**) ; les 3 bases legacy restent à **62** (colonnes GO2 sans objet pour leurs suites) ; `icode_host_pro` reste à **60/63**.
- **Patches (2, hors git, écrits par Git lui-même)** : `recette/diff-stripe-test.patch` (`git diff 78b51ce <HEAD> --binary --full-index`) et **`recette/diff-go2-corrections.patch`** (`git diff 41f44eb <HEAD> --binary --full-index`) ; **statistiques + SHA-256 : `recette/GUIDE-RECETTE-STRIPE.md`** (calculés après le dernier commit, sans commit de cachet). Vérifications de fidélité : export **déterministe** (2 exports → SHA-256 identiques) + `git apply --check --reverse` → **exit 0**.
- **Preuves de parcours (hors git)** : `recette/parcours-stripe.mjs`, `recette/stripe-checks.json` (38 checks), `recette/stripe-01…13-*.png` (13 captures), `recette/GUIDE-RECETTE-STRIPE.md`.

---

## 9. Revue GO2 — défauts P1→P8 (corrections · preuves · chiffres)

**Contexte.** La revue du patch Stripe sur `feat/stripe-test` @ `41f44eb` a relevé **8 défauts** (P1→P8). **GO2** les corrige sans modifier le design GO1 : **commit `209de8f`** (20 fichiers, **+2 524 / −295**) + migration additive **`20261007000003_go_p1_p8_corrections`** (63ᵉ sur `icode_host_pro_socle` **et** `icode_host_pro_recette` ; **`icode_host_pro` reste 60/63 — jamais migré en dev**).

| P | Défaut relevé en revue | Correction livrée | Preuve |
|---|---|---|---|
| **P1** | identité de la source webhook traitée à côté de la signature : un webhook « traitable » sans identité marchande pouvait être acquitté ou rattaché à tort | identité résolue **après** signature ; helper `isHandledEventType` : **type traité sans identité → 503 `provider_identity_unavailable` + ligne `FAILED`** ; **type hors périmètre → 200 `IGNORED` sans identité** ; garde cross-provider via `resolveFor` | e2e `card-topup` **E8** ; unit `card-payments` (cross-provider), `payment-provider` **15/15** |
| **P2** | clé de tentative régénérée à chaque clic : double soumission = 2ᵉ session = 2ᵉ intention | helpers `sessionStorage` `icode-topup-attempt` (`topupAttemptKey` / `attachTopupAttempt` / `clearTopupAttempt`, garde `typeof window`), clé au format `web-topup-<b36>-<b36>` ; `createCardTopup(..., idempotencyKey)` ; effacement sur `SUCCEEDED` ou terminal `FAILED\|CANCELED\|EXPIRED\|NEEDS_REVIEW` | **navigateur C-GO2 12/12** + `DB_COUNTS n500=1\|n800=1` |
| **P3** | reprise d'une tentative existante non fiable (relance = seconde tentative) | clé métier `topup:<ref>` ; états `providerCallState` `DISPATCHED`/`RESOLVED`/`UNCERTAIN` + `dispatchedAt` ; tentative `RECEIVED` reprise avec `reconcileAt` et backoff (`reconcileDue` / `reconcileIntervalMs`) | e2e **I1** ; unit `payment-webhook` (reprise + backoff) |
| **P4** | résolution d'identité prestataire dispersée et non testée isolément | service dédié `payment-provider.service` : `resolve` / `resolveFor` / `assertSimulatorUsable` / `currentIdentity` (+ `webhookEndpointUrl`) | spec dédiée **15/15** ; `simulated-connector` compteurs de dispatch |
| **P5** | annulation d'un remboursement possible **après** envoi chez le prestataire | `cancelRefund` refusé si `dispatchedAt` présent + audit `refund.topup.cancel_refused` | e2e **I4** ; unit `card-refunds` **17/17** |
| **P6** | remboursement interne non idempotent (double application possible) | chemin interne idempotent (`applyProviderRefundStatus`, ligne retrouvée par `findUnique`) | e2e **I3** ; unit `card-refunds` |
| **P7** | notice d'échec pouvant modifier l'état ou le solde d'un intent vivant | `markFailureNotice` : notice seule — **état et solde inchangés** | e2e **I2** ; unit `card-payments` (notice) |
| **P8** | devise du portefeuille vérifiée hors verrou (course possible) | garde `walletCurrency` **sous `FOR UPDATE`** dans `wallet.service` | unit `wallet` **+2 tests** (30/30) |

**Batterie GO2 relancée intégralement après `209de8f`** : `tsc` API **0** · `tsc` web **0** · `nest build` **0** · `next build` **0** · unit **1314/1314 — 71 suites** · e2e principal **583/583 — 48 suites** (`card-topup` **48/48**, nouveau bloc **« I — corrections GO2 »** : I1 reprise P3, I2 notice P7, I3 idempotence P6, I4 annulation P5) · e2e legacy **39/39** → **622/622 — 52 suites** · lint : **ESLint absent du workspace (non exécutable, préexistant)**.

**Vérification navigateur GO2 (P2), exécutée en autonomie :** stack locale du worktree principal (API `node dist/src/main.js` :3001 base socle + simulateur, web `next start` :3003), Edge headless **CDP sans proxy** — 12 checks **0 échec** : login 201 · page hébergée joignable · tentative 1 → clé `web-topup-muy3gitz-9qf7by8yi` + réf `CDP-0221079FE9` persistées · tentative 2 → **même clé, même session `cs_sim_b0fa12d39d21b578`, même référence** · montant différent → nouvelle clé/session · **0 requête hors localhost** · corroboration SQL `n500=1|n800=1` · fixture nettoyée (`POSTCLEAN CLEANUP_OK`), `EXIT=0`.

**Limites inchangées :** catégorie **B** (Stripe réel) et **D** (live) **BLOQUÉES** ; aucune clé réelle, aucun appel réseau sortant ; simulation ≠ validation prestataire.

---

## 10. Ce que ce rapport NE dit PAS

Aucune **appel réseau réel vers Stripe**, aucune carte réelle, aucun compte Stripe, **aucun push ni merge**, **aucune mise en production**, **aucune activation commerciale**, aucun chiffre d'argent réel manipulé. La **catégorie B est BLOQUÉE** : la simulation (connecteur `simulated`, clés factices `pk_test_51RECETTE_DEMO_FICTIVE` / `sk_test_…_FICTIF_NON_REEL` / `whsec_recette_demo_fictif_non_reel`) ne vaut **jamais** validation du prestataire. **Limites d'exécution** : lint ESLint non exécutable (préexistant — typechecks + builds verts) ; `icode_host_pro` (dev local) non migré (60/63, voulu) ; colonne `error` du panneau webhook tenant un `note` (cosmétique). **Litiges et remboursements** n'ont été exercés que via des webhooks signés simulés.

**ARRÊT ICI pour revue unique (GO item fin)** : le statut = **`feat/stripe-test` locale (4 commits de code : `d97d39c` · `650906a` · `e7374ee` · `209de8f` + commits documentaires) + rapports + **2 patches vérifiés** (global `78b51ce…HEAD`, corrections `41f44eb…HEAD`), prêts pour revue — merge/push **uniquement sur décision explicite**, recette laissée accessible sur `http://localhost:3002`.
