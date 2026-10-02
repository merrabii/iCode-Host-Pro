# Audit du socle commercial existant — Étape 1

**Date :** 2026-10-02 · **Base :** `2174eb6f2125fb52729685bbf65fbc36dc958f29` · **Branche :** `audit/socle-commercial` (worktree recette, sans commit)
**Consolidation :** 2026-10-02 (GO ciblé — rectifications sans refaire l'audit ; constats code inchangés).
**Objectif de lancement :** plateforme de gestion clients, commandes, factures, abonnements, avec portefeuille sécurisé, paiement par solde et recharge par carte/virement. **Prestataire de paiement : à choisir (aucun n'est sélectionné ici).**
**Cadre respecté :** audit seul — aucune correction applicative, aucune installation de dépendance, aucun appel provider externe, aucun paiement, aucune migration, aucune activation, aucun commit ni push. **Autorisé et exécuté :** reproduction HTTP isolée en base de test identifiée (`icode_host_pro_c4test`, garde `current_database()`) avec **fixtures créées/supprimées** et **panneau factice local 127.0.0.1** (aucun appel réseau sortant).

**Méthode :** lecture UI → contrôleur → service → modèle Prisma avec références `fichier:ligne` ; vérifications recoupées par recherches (`grep`) indépendantes ; **chaîne d'autorisation vérifiée à 3 niveaux (gardes globaux → contrôleur → service)** puis **reproduction HTTP isolée (7/7 PASS)** ; tests ciblés unitaires exécutés le 2026-10-02 ; preuves e2e antérieures réutilisées avec leur date et leurs limites. **Une table, un bouton ou un test ancien ne prouve pas qu'un parcours fonctionne aujourd'hui** : chaque ligne de validation indique son environnement, sa date, sa preuve et ses limites.

**Légende implémentation :** `absente` / `partielle` / `présente` · **Légende validation :** `PASS` / `ÉCHEC` / `BLOQUÉ` / `NON TESTÉ`.

---

## 1. Matrice des capacités et validations

### 1.1 Clients et accès

| Capacité | Implémentation | Validation | Environnement · date · preuve · limites |
|---|---|---|---|
| Inscription (à la commande, gratuite, invitation) | **présente** — `auth.controller.ts:45-92`, `auth.service.ts:55-135`, `store/checkout.service.ts:166-213` | **PASS** | e2e recette (DB test + simulateurs) · 2026-09-02 (`test/auth-register.e2e-spec.ts`) — intention requise, flag OFF→403, compte+subscription · non relancé à ce jour |
| Connexion, MFA, OAuth | **présente** — `auth.controller.ts:94-114`, `mfa.service.ts:56-67` | **PASS** | e2e recette · 2026-09-02/09-21 (`mfa`, `oauth`, `security-settings`) · non relancé |
| Isolation des données entre clients | **présente** — `subscriptions.service.ts:105,203`, `deployments.service.ts:1517+`, `tickets.service.ts:33-43` | **PASS** | e2e recette · 2026-09-25 (`test/client.e2e-spec.ts` « cross-client isolation ») · non relancé |
| Sessions (refresh rotatif, impersonation lecture seule) | **présente** — `jwt-auth.guard.ts`, `auth.controller.ts:135-158` | **PASS** | e2e · 2026-09-12 (`impersonation`) · non relancé |
| **Récupération de mot de passe oublié** | **absente** (aucun endpoint `forgot/reset`, `change-password` exige le mdp courant — `auth.controller.ts:125-131`) | **NON TESTÉ** | capacité inexistante — rien à exécuter |
| **Édition du profil (nom/email)** | **absente** (aucun `PATCH /users/me` ; `cart/page.tsx:224-232` y renvoie pourtant) | **NON TESTÉ** | idem |
| **Suppression/anonymisation de compte** | **absente** (aucun `DELETE` user) | **NON TESTÉ** | idem |

### 1.2 Catalogue et tarifs

| Capacité | Implémentation | Validation | Environnement · date · preuve · limites |
|---|---|---|---|
| Prix et cycle (HT, options, addons, installation) recalculés **côté serveur** | **présente** — `checkout.service.ts:583-679` (`buildPricing`, serveur autoritaire, jamais reçu du client) | **PASS** | unit · **2026-10-02** (`checkout.service.spec`, `checkout-c3.spec` — 137/137 PASS global) + e2e 2026-09-20 · limites : mocks, pas de cas TVA≠0 |
| Taxes (taux + snapshot `taxRatePercent` sur Order/Invoice) | **partielle** — snapshot serveur ✔ (`checkout.service.ts:596,674-676`, `schema.prisma:1327,1417`) mais **taux non administrable** (aucun endpoint TaxRate/BillingSetting ; seed seul `seed-store.ts:547-553`) et **affichage client sans TVA** | **NON TESTÉ** | aucun test avec `taxAmountCents ≠ 0` (toutes les assertions e2e = 0) ; test front **BLOQUÉ** : `apps/web` n'a **ni runner de tests ni fichiers `*.spec/test`** (vérifié) → runner (jest/vitest) = installation de dépendance → **GO dédié** (ressources vérifiées, pas de « mandat d'audit ») |
| **Promotion : affiché ≠ facturé** | **partielle (incohérente)** — boutique affiche `promoPriceHtCents` **barré** et propose `priceHtCents` comme prix courant (`shop/page.tsx:19,23,27` — sémantique inversée) ; le serveur facture **toujours** `priceHtCents` (`checkout.service.ts:600`, **0 occurrence** de `promoPriceHtCents` dans `store/`) | **ÉCHEC** | constat par lecture · 2026-10-02 — l'affichage barré ne correspond à aucun décompte : **le montant facturé ignore la promo**. Ancien constat doc (`suivi-projet.html:416`) confirmé par le code |
| Cohérence arrondi client/serveur | **partielle** — client : arrondi global (`cart/page.tsx:107`, `checkout/payment/page.tsx:140`) ; serveur : arrondi par ligne (`checkout.service.ts:596`, somme `:674-676`) | **ÉCHEC** | divergence structurelle confirmée 2026-10-02 (ex. 3 lignes × 1 c à 20 % : client 1 c, serveur 0 c) |
| Panier frais (re-fetch des prix) | **absente** — snapshot figé à l'ajout (`shop/[slug]/page.tsx:525-532`), lu depuis localStorage (`cart-provider.tsx:34-42`), **zéro re-fetch** | **NON TESTÉ** | serveur reste autoritaire → écart possible affiché/débité, non signalé à l'utilisateur |
| Devise | **partielle** — devise snapshot sur Order/Invoice (`schema.prisma:1326,1416`) mais `formatCents` codé en dur USD (`api.ts:1089`) et `BillingSetting.currency` non exposé | **NON TESTÉ** | aucune couverture devise |

### 1.3 Commandes

| Capacité | Implémentation | Validation | Environnement · date · preuve · limites |
|---|---|---|---|
| Création + transaction atomique (Order, Invoice, Subscription, historique) | **présente** — `checkout.service.ts:293-491` | **PASS** | unit **2026-10-02** (137/137) + e2e 2026-09-20 (`store-checkout-domains`, 21 tests) · limites : e2e non relancé à ce jour |
| Idempotence (clé déterministe sha256 + `@unique` + replay + `P2002`) | **présente** — `checkout.service.ts:215-233,789-813`, `schema.prisma:1314` ; verrou `FOR UPDATE` **uniquement sous C3 + membre** (`:302-324`) | **PASS** | unit 2026-10-02 (`checkout-c3.spec` 12 tests) ; e2e double-clic 2026-09-20/09-27 (`c3-provisioning` « 2 checkouts simultanés → 1 commande ») · limites : chemin invité/legacy non sous verrou explicite = **risque résiduel R-CMD-02** |
| **Replay après annulation** | **partielle (à spécifier)** — **même intention** (double-clic/retry) : le replay renvoie la commande existante **sans créer de doublon** (`checkout.service.ts:215-233,308,557`) — comportement anti-doublon **correct et à conserver**. **Nouvel achat après annulation** : la clé étant dérivée du contenu (jamais du statut), la même configuration renvoie la commande `CANCELLED` avec `nextStep: 'provisioning-pending'` (**réponse trompeuse**) et aucun rachat n'est possible. | **ÉCHEC** (réponse) / **règle à trancher** (rachat) | constat 2026-10-02 ; **rectifié** : il faut distinguer rejeu de la même intention vs nouvel achat — **aucune suppression de clé ni filtrage des commandes annulées n'est préconisé** (cela rouvrirait les doublons) ; mécanique explicite de **nouvelle intention** à spécifier (ex. portée de clé par session de checkout) + tests : retry → 1 commande · rachat après annulation → 2e commande · double-clic → 0 doublon |
| **Paiement** | **partielle — simulé** — `Order=PAID` + `Invoice=PAID` immédiats (`checkout.service.ts:92-93,363,422,453` « simulation instantanée ») ; **0** occurrence de prestataire/webhook (`stripe/paypal/webhook` = 0 dans `apps/`) ; type de moyen **jamais discriminé** (seul `isActive` — `:150-155`) | **NON TESTÉ** (réel) | le test « payé » existant valide la **simulation** ; **aucun PASS réel** : aucun encaissement, aucun prestataire sélectionné. Un `CARD` activé serait « payé » sans saisie |
| Provisioning à preuve (proof-gate, CAS d'activation, leases C3) | **présente** — `provisioning.service.ts:288-350,1110-1144,1220-1296` | **PASS** | unit 2026-10-02 + e2e 2026-09-15/09-27 (proof-gate, C3, C4) · limites : preuves exécutées sur panneaux **simulés** ; des interactions panneau réelles existent par ailleurs (env dev connectée à `portal.arumdigital.com` — CLAUDE.md §2 ; Hestia pour les métriques — §4) **sans valider le code actuel**, et la recette a évité les builds réels (`RAPPORT-LOT-B.md:285`) |
| Réconciliation (seul timer du dépôt) | **présente** — `reconcile.runner.service.ts:131-165`, `reconcile.service.ts:65-335` | **PASS** | e2e recette **2026-09-29** (`c4-*`) réutilisée ; **unit `reconcile*` non exécutées** dans les 7 suites du 02/10 (attribution rectifiée) |
| **Échec** | **partielle** — `Deployment=FAILED` après 2 échecs (`reconcile.service.ts:201-253`) mais **`Order` n'a jamais d'état d'échec** (enum sans `FAILED`, `schema.prisma:1178-1186`) ; un Order resté `PAID` n'est repris par **aucun worker** | **NON TESTÉ** | aucun test de reprise d'échec Order ; capacité non terminal |
| Annulation / terminaison | **présente côté API admin, UI absente** — `order-cancel.service.ts:181-491` (gates + CAS), routes `store-provisioning.admin.controller.ts:39-125` ; **0 appel** dans `apps/web` | **PASS** (API) / **NON TESTÉ** (UI) | unit **2026-10-02** (`order-cancel` 42 + `order-terminate` 37 tests) + e2e 2026-09-24 · limites : aucune interface existante à tester |

### 1.4 Factures

| Capacité | Implémentation | Validation | Environnement · date · preuve · limites |
|---|---|---|---|
| Émission atomique dans la transaction de commande | **présente** — `checkout.service.ts:417-448` (seul `invoice.create` du dépôt) | **PASS** | unit 2026-10-02 + e2e 2026-09-20 |
| Numérotation (`UPDATE … RETURNING` atomique `claimInvoiceSequence`) | **présente** — `checkout.service.ts:815-834` | **PASS** (sérialisation) / **NON TESTÉ** (unicité sous concurrence) | unit 2026-10-02 (mock `checkout-c3.spec:88,103-105`) · **aucun test d'unicité réelle** ; création paresseuse du singleton **sans contrainte unique** = risque **R-FAC-01** (deux séries → `Invoice.number` P2002 → achat refusé ; déjà tracé `TASKS.md:1315`) |
| **Numérotation par exercice** | **absente dans le code** — préfixe = année courante mais **aucune remise à zéro de séquence** (`checkout.service.ts:831-832`) → « 2027-0150 » au 1er janvier | **NON TESTÉ** | **fait** (comportement constaté) ≠ **exigence** : la remise à zéro annuelle est une **règle de gestion/comptable à trancher** (§6-6), pas un défaut établi |
| Montants figés (snapshot, zéro `invoice.update`) | **présente** — `schema.prisma:1438-1452` sans FK produit ; lecture seule partout (`order-cancel.service.ts:782-798`) | **PASS** | unit 2026-10-02 (assert `invoice.update === undefined` — `order-terminate.service.spec:538`) |
| **Consultation (client + admin)** | **absente** — **0** `invoice.findMany` / `order.findMany` / `customer.findMany` dans `apps/api/src` ; aucune route ni page · alors que `checkout/success/page.tsx:50-52,239-240` **promet** « retrouvez facture et identifiants dans votre espace client » | **NON TESTÉ** | capacité inexistante (impasse UI confirmée) |
| **Téléchargement PDF** | **absente** — `Invoice.pdfPath` (`schema.prisma:1425`) **jamais écrit**, aucune lib ni route | **NON TESTÉ** | idem |
| **Avoirs / remboursements (facture)** | **absente** — enums `REFUNDED/CREDITED`, `creditNoteOfId`, `InvoiceLineKind.CREDIT` déclarés, **jamais écrits** | **NON TESTÉ** | idem |
| Mentions légales / échéance de paiement | **absente** — `legalMentionsSnapshot`, `dueDate`, `BillingSetting.legalMentions` jamais renseignés | **NON TESTÉ** | idem |

### 1.5 Abonnements

| Capacité | Implémentation | Validation | Environnement · date · preuve · limites |
|---|---|---|---|
| Activation à la commande (« le paiement vaut approbation ») | **présente** — `checkout.service.ts:458-488` (ACTIVE dans la même TX) | **PASS** | unit 2026-10-02 (`subscriptions.service.spec` 16 tests) + e2e 2026-09-20/09-25 |
| Cycle de vie manuel (suspension/résiliation admin avec whitelist) | **présente** — `admin.controller.ts:32-49`, `subscriptions.service.ts:36-56,352-394` | **PASS** | unit 2026-10-02 + e2e `client` 2026-09-25 (transitions refusées/acceptées) |
| Résiliation client avec verrous (apps liées, allocations) | **présente** — `subscriptions.service.ts:203-284` (TX, `FOR UPDATE`) | **PASS** | unit 2026-10-02 (gates D10) |
| **Échéances** | **absente** — `Order.nextBillingDate/autoRenew/renewsOrderId` : **0 occurrence** dans le code applicatif | **NON TESTÉ** | champs morts |
| **Renouvellement / dunning** | **absente** — aucun `@Cron`/`ScheduleModule` (unique mention = un commentaire `reconcile.service.ts:15`) ; `BillingSetting.dunning*` jamais lu → un produit MONTHLY/YEARLY **n'expire jamais** | **NON TESTÉ** | aucune 2e création de facture dans le dépôt |
| **Suspension automatique à échéance** | **absente** (manuelle uniquement) | **NON TESTÉ** | idem |
| **Changement d'offre** | **partielle** — chemin serveur d'upgrade existe (`checkout.service.ts:464-476`, `subscriptions.service.ts:141-194` sans route) mais **refusé sous C3** (`:312-322`) et UI « non encore disponible » (`client/page.tsx:1433-1441`) | **NON TESTÉ** | capacité déclarée à l'écran comme indisponible |
| **Suspension admin = action infra ?** | **à vérifier** — `SUSPENDED` ne fait que changer un statut (`subscriptions.service.ts:370-373`), **aucune action sur les apps** | **BLOQUÉ** | prérequis : décision sur l'effet attendu (arrêter les ressources ?) puis test dédié — sinon service rendu gratuitement |

### 1.6 Portefeuille

| Capacité | Implémentation | Validation | Environnement · date · preuve · limites |
|---|---|---|---|
| Historique des mouvements | **absente** — `WalletTransaction` **jamais lu ni écrit** (0 occurrence hors `schema.prisma`/migration) | **NON TESTÉ** | table orpheline |
| Calcul/stockage du solde | **absente** — `Customer.walletBalanceCents` (`schema.prisma:1237`) sans aucun code | **NON TESTÉ** | idem |
| Crédits/débits atomiques, concurrence, anti double-débit | **absente** — les gardes du schéma (`idempotencyKey @unique :1289`, commentaire `$transaction :1228-1229`) **ne sont jamais mises en œuvre** | **NON TESTÉ** | rien à tester ; **risque futur** : écriture directe hors `$transaction` si développement sans service dédié (**R-WAL-01**) |
| Contrôle des droits (seul le propriétaire débite) | **absente** | **NON TESTÉ** | idem |

### 1.7 Recharges (carte / virement)

| Capacité | Implémentation | Validation | Environnement · date · preuve · limites |
|---|---|---|---|
| **Confirmation fiable avant livraison** | **absente** — commande `PAID` immédiate **y compris pour virement** (`checkout.service.ts:363,422`) ; seed invitant à « joindre une capture » (`seed-store.ts:524`) **sans aucun formulaire** | **NON TESTÉ** | aujourd'hui : livraison sans encaissement ni confirmation |
| **Signature webhook / anti-rejeu** | **absente** — 0 endpoint webhook, 0 HMAC, **`rawBody` absent de `main.ts` aujourd'hui** (fait : option `rawBody: true` de NestJS à activer au bootstrap, pas une refonte Express), 0 clé prestataire dans `config/configuration.ts` | **NON TESTÉ** | **BLOQUÉ** : prérequis = choix de prestataire (§6-1 — modalité de vérification exacte à confirmer avec lui) + endpoint dédié (lot C1) |
| **Moyens de paiement (config)** | **présente (config seule)** — public `payment-methods.controller.ts:16-37`, admin `billing-payment.admin.controller.ts:41-110` (PATCH), types `CARD`/`BANK_TRANSFER`/`MANUAL_TRANSFER` (`schema.prisma:1151-1155`, seed `seed-store.ts:496-543`) | **PASS** (lecture config) / **NON TESTÉ** (gestion admin : **0 UI**) | e2e via specs checkout · limites : `configEnc` jamais chiffré/lu ; frais (`feePercent/feeFixedCents`) **jamais appliqués** au calcul (`buildPricing` :583-679) |
| **Remboursements** | **absente** — `OrderStatus.REFUNDED` **jamais écrit** (0 écriture dans le dépôt) | **NON TESTÉ** | idem |
| **Rapprochement financier** | **absente** — `reconcile.*` porte sur déploiements/DNS, pas sur les flux financiers | **NON TESTÉ** | capacité non définie |

### 1.8 Administration et journal

| Capacité | Implémentation | Validation | Environnement · date · preuve · limites |
|---|---|---|---|
| Journal d'audit (création, lecture ADMIN, immuable) | **présente** — `audit.service.ts:30-48` (`record` best-effort), `audit.controller.ts:21` | **PASS** | unit **2026-10-02** (`audit.service.spec`) + e2e 2026-08-31 (403 USER, pagination) |
| **Couverture de l'audit** | **partielle** — `payment.checkout` **sans acteur** (`checkout.service.ts:837-851`) ; transitions `OrderStatus` (PAID/PROVISIONING/ACTIVE) **jamais dans l'AuditLog** ; `payment.method.update` sans valeurs de frais | **NON TESTÉ** | lacunes confirmées par lecture |
| **RBAC administration** | **partielle — faille confirmée (statique + HTTP)** : `deployment-modules.controller.ts:28` = `JwtAuthGuard` seul, **0 garde global** (grep `APP_GUARD`/`useGlobalGuards` = 0) ; **`GET /` (:41), `GET :id` (:47), `GET :id/projects` (:74) sans `RolesGuard` ni `@Roles`** ; `RolesGuard` **autorise par défaut** les routes sans `@Roles` (`roles.guard.ts:16,29-31`) ; le service **ne vérifie aucun rôle** et `findAll/findOne` exposent `hostname`/`panelProvider`, `listProjects` appelle le panneau (`deployment-modules.service.ts:54-76,132-150`) | **ÉCHEC** | **statique** (chaîne complète vérifiée 2026-10-02) + **reproduction HTTP isolée 7/7 PASS** (base `icode_host_pro_c4test`, panneau factice local) : sans jeton → **401 ×3 et 0 appel panneau** ; USER → **200** sur les 3 GET + **appel panneau observé** (Bearer) sur `:id/projects` ; contrôle ADMIN 200 ; USER sur mutation POST → **403** |
| **Listing clients / commandes / factures / paiements** | **absente** — 0 `findMany`, aucune route, aucune page (nav `config/nav.ts:24-59` sans entrée) ; substitution partielle : colonne « Commande » des souscriptions (`subscriptions.service.ts:336-345`) | **NON TESTÉ** | capacité inexistante |
| **Tableau de bord / KPI commerciaux** | **partielle** — `manager.service.ts:16-22` : produits, serveurs, users **uniquement** (0 CA, 0 commande, 0 facture) | **NON TESTÉ** | idem |
| Actions admin sur commande (provision/cancel/terminate/finalize) | **présente (API) / absente (UI)** — `store-provisioning.admin.controller.ts:39-125`, **0 appel web** | **PASS** (API, e2e 2026-09-24) / **NON TESTÉ** (UI) | admin non autonome |

**Résumé d'état (recalculé depuis les 52 lignes de matrice, règle = statut principal de la ligne) :** `présente` : **19** · `partielle` : **11** · `absente` : **21** · `à vérifier` : **1** (suspension admin). Validations : **PASS 19** · **ÉCHEC 4** · **BLOQUÉ 1** · **NON TESTÉ 28** (somme 52 ✔).

**Lignes à statut mixte (comptées par leur statut principal, second statut conservé en colonne limites) :** 4 lignes — « Annulation/terminaison » (PASS API / NON TESTÉ UI), « Numérotation » (PASS sérialisation / NON TESTÉ unicité concurrence), « Moyens de paiement » (PASS lecture config / NON TESTÉ gestion admin), « Actions admin commande » (PASS API / NON TESTÉ UI). Elles portent sur des **sous-fonctions distinctes**, pas sur une contradiction d'un même test.

---

## 2. Schéma du parcours : commande → paiement → facture → provisioning

**État réel aujourd'hui (aucun encaissement) :**

```
[Panier]  cart/page.tsx (snapshot localStorage, zéro re-fetch)
   │  POST /store/checkout  (checkout/payment/page.tsx:82-116)
   ▼
[Contrôleur]  store/checkout.controller.ts:42-49   OptionalJwtAuthGuard (invité ou membre)
   ▼
[Service checkout]  store/checkout.service.ts
   ├─ rate-limit :128-137 (renvoie 404 ≠ 429)          ├─ produit/méthode :140-155 (seul isActive testé)
   ├─ prix RECALCULÉS serveur :158-159 (buildPricing :583-679 — promo JAMAIS appliquée :600)
    ├─ clé idempotence sha256 :215-218 ─ replay :220-233 (rejeu d'intention : statut ignoré — voir E-08)
   ├─ verrou User FOR UPDATE :302-324 (si C3 + membre ⚠ sinon sans verrou)
   ▼
[Transaction unique :293-491]
   ├─ claimInvoiceSequence :815-834 (UPDATE…RETURNING, singleton SANS contrainte unique ⚠)
   ├─ Order  status = PAID   :363      ◄── PAIEMENT SIMULÉ (aucune étape PENDING_PAYMENT)
   ├─ HostingService         :399-414
   ├─ Invoice status = PAID  :417-448  (montants figés, numéro YYYY-nnnn, pdfPath jamais rempli)
   ├─ OrderStatusHistory     :449-456  « Paiement validé (simulation instantanée) »
   └─ Subscription ACTIVE    :458-488  (« le paiement vaut approbation »)
   ▼
[Audit + Email]  audit payment.checkout SANS acteur :493,837-851 · email :497-503
   ▼
[Provisioning fire-and-forget :505-523]  store/provisioning.service.ts
   ├─ proof-gate :288-350 (jamais ACTIVE sans preuve)
   ├─ awaitAppReady :1110-1144 (panel puis HTTP 2xx/3xx)
   ├─ activation CAS :1220-1296 (Order PROVISIONING→ACTIVE + Deployment DEPLOYING→ACTIVE)
   └─ échec : Deployment=FAILED après 2 essais (reconcile.service.ts:201-253)
                ⚠ Order reste PROVISIONING — aucun état d'échec Order, aucune reprise PAID
```

**Ce qui manque sur ce schéma (point par point) :** étape `PENDING_PAYMENT` → confirmation encaissement (webhook/signature/anti-rejeu) · portefeuille/`WalletTransaction` (débit solde) · validation de virement avant livraison · écriture `walletTransactionId` sur Order/Invoice · état d'échec terminal sur Order · remboursement (`REFUNDED` jamais écrit) · consultation ultérieure de la facture.

---

## 3. Anomalies classées par gravité

### 🔴 Critique (bloquant toute mise en production commerciale)

| # | Type | Constat | Preuve |
|---|---|---|---|
| C-01 | **Défaut confirmé** | **Paiement simulé universel** : `Order`+`Invoice` créés `PAID` à la soumission, y compris virement/carte → provisioning, création de compte et email d'accès **sans aucun encaissement**. C'est le chemin unique aujourd'hui. | `checkout.service.ts:92-93,363,422,449-456,505-523` ; grep `stripe/paypal/webhook` = 0 |
| C-02 | **Défaut confirmé (statique + HTTP)** | **Faille RBAC admin** : `GET admin/deployment-modules`, `GET :id`, `GET :id/projects` sans `RolesGuard` ni `@Roles`, **aucun garde global** (0 `APP_GUARD`/`useGlobalGuards`), service sans contrôle de rôle → tout utilisateur authentifié lit `hostname`/`panelProvider` et **déclenche un appel panneau** (contre `CLAUDE.md §4`). Mutations protégées (403 USER vérifié). | `deployment-modules.controller.ts:28,41,47,74` ; `roles.guard.ts:16,29-31` (défaut autorisé sans `@Roles`) ; `deployment-modules.service.ts:54-76,132-150` ; **reproduction HTTP 7/7 (2026-10-02, base isolée, panneau local)** |
| C-03 | **Défaut confirmé** | **Portefeuille absent** (0 code) alors qu'il est dans l'objectif de lancement : solde, mouvements, atomicité, anti double-débit, droits — tout est à construire. | grep `walletBalanceCents\|WalletTransaction\.` sur `apps/api/src`+`apps/web/src` = **0** |
| C-04 | **Défaut confirmé + exigence à confirmer** | **Recharges absentes** : aucun prestataire, aucun webhook, **`rawBody` absent de `main.ts` aujourd'hui** (fait), aucune confirmation de virement, aucun remboursement ni rapprochement. *Nuance :* l'activation du corps brut est une **option de bootstrap NestJS** (`rawBody: true`), pas une refonte Express ; la **modalité de vérification exigée dépend du prestataire choisi** (décision ouverte §6-1). | `main.ts:10` (`NestFactory.create(AppModule)` sans `rawBody`) ; grep prestataires = 0 ; `seed-store.ts:524` promet une preuve inexistante |

### 🟠 Élevée (bloquant le lancement ou rompant la confiance client)

| # | Type | Constat | Preuve |
|---|---|---|---|
| E-01 | Défaut confirmé | **Promo affichée mais jamais facturée** + sémantique inversée (prix courant = `priceHtCents`, prix barré = promo) → le client voit un prix barré qu'il paie quand même. | `shop/page.tsx:19,23,27` vs `checkout.service.ts:600` (0 promo dans `store/`) |
| E-02 | Défaut confirmé | **Factures non consultables** (0 `invoice.findMany`, aucune route/page client/admin) alors que la page de success **promet** facture + suivi dans l'espace client. PDF absent (`pdfPath` jamais écrit). | `checkout/success/page.tsx:50-52,239-240` ; grep findMany = 0 |
| E-03 | Défaut confirmé | **Aucun listing admin** clients/commandes/factures/paiements ni KPI (dashboard = produits/serveurs/users). | `manager.service.ts:16-22`, `config/nav.ts:24-59` |
| E-04 | Défaut confirmé | **Aucun renouvellement/échéance/suspension auto** : `nextBillingDate/autoRenew/dunning` jamais lus, aucun scheduler → offres récurrentes n'expirent jamais, jamais rejumelées. | grep = 0 ; `reconcile.service.ts:15` (comment) |
| E-05 | Défaut confirmé | **Aucun remboursement/avoir** : `OrderStatus.REFUNDED` et `InvoiceStatus.REFUNDED` **jamais écrits** ; annulation/termination explicitement sans effet facture. | grep écritures REFUNDED = 0 ; `order-cancel.service.ts:45-46,300,469` |
| E-06 | Défaut confirmé | **Pas de récupération de mot de passe** (self-service ni admin) : `change-password` exige le mdp courant → compte perdu = blocage définitif. | `auth.controller.ts:125-131`, grep forgot/reset = 0 |
| E-07 | Défaut confirmé | **Pas de vue client des commandes/factures** (0 `findMany`, nav sans entrée) — rupture entre la promesse post-achat et le produit. | `client/page.tsx`, `config/nav.ts:78-89` |
| E-08 | **Défaut confirmé (réponse) + règle à spécifier** | **Rejeu et nouvel achat non distingués** : le replay renvoie la commande existante **quel que soit son statut** — correct pour un double-clic/retry (**anti-doublon, à conserver**) mais après annulation la même configuration renvoie `CANCELLED` avec `nextStep: 'provisioning-pending'` (**réponse trompeuse**) et aucun rachat n'est possible ; le panier n'est jamais vidé (`cart-provider.tsx:44-47`). **Aucune suppression de clé ni filtrage des commandes annulées n'est préconisé** (doublons). | `checkout.service.ts:215-233,308,557` ; `cart-provider.tsx:44-47` ; spécification de la **nouvelle intention** = critère du lot C0 |
| E-09 | Défaut confirmé | **Type de moyen de paiement jamais validé** : seul `isActive` compte → un `CARD` activé serait « payé » instantanément sans saisie ni encaissement. | `checkout.service.ts:150-155` |
| E-10 | Défaut confirmé | **Échec non terminal côté Order** : `Deployment=FAILED` laisse l'Order `PROVISIONING` ; un Order resté `PAID` n'est repris par aucun worker (seul timer = réconciliation des `DEPLOYING`). | `schema.prisma:1178-1186`, `reconcile.service.ts:231-242`, `checkout.service.ts:505-523` |

### 🟡 Moyenne (dette fonctionnelle ou de conformité)

| # | Type | Constat | Preuve |
|---|---|---|---|
| M-01 | Défaut confirmé | **Taux de taxe non administrable** (aucun endpoint TaxRate/BillingSetting ; seed seul) + **aucun test TVA ≠ 0**. | `checkout.service.ts:819-833` ; assertions e2e toutes à 0 |
| M-02 | Défaut confirmé | **Divergence d'arrondi client/serveur** (global vs par ligne) — écart affiché/débité possible. | `cart/page.tsx:107`, `checkout/payment/page.tsx:140` vs `checkout.service.ts:596,674-676` |
| M-03 | Défaut confirmé | **Panier jamais re-fraîchi** (snapshot localStorage) ; l'écart serveur n'est jamais signalé à l'utilisateur. | `cart-provider.tsx:34-42`, `shop/[slug]/page.tsx:525-532` |
| M-04 | **Fait constaté / règle à trancher** | **Numérotation** : séquence **non remise à zéro par exercice dans le code** (fait : préfixe année + compteur continu) — que ce doive changer est une **règle comptable à décider** (§6-6), pas un défaut établi. `legalMentionsSnapshot`/`dueDate` jamais remplis = fait. | `checkout.service.ts:831-832`, `schema.prisma:1422,1428` |
| M-05 | Défaut confirmé | **Audit incomplet** : `payment.checkout` sans acteur, transitions de commande hors AuditLog, frais de moyen de paiement non journalisés. | `checkout.service.ts:837-851`, `billing-payment.admin.controller.ts:63+` |
| M-06 | Défaut confirmé | **UI admin orphelines** : 5 actions commande + gestion moyens de paiement sans aucune interface ; admin dépend du support dev. | grep web `store/admin` = 0 |
| M-07 | Défaut confirmé | **Profil non éditable** (nom/email) et **aucune suppression/anonymisation de compte** (RGPD). | `users.controller.ts` (pas de `PATCH /me`/`DELETE`) |
| M-08 | Défaut confirmé | **Devise codée en dur USD** (`formatCents`) ; `BillingSetting.currency` non exposé ; double devise affichée ailleurs. | `api.ts:1089`, `manager/subscriptions/page.tsx:171` |
| M-09 | **Fait constaté (nuancé)** | **0 test unitaire frontend** (`apps/web` : aucun `*.spec/test.*`, **aucun runner** — scripts dev/build/start seuls) — la couche affichage/promo/taxe est sans garde automatisé. *Nuance :* l'absence de tests dans `apps/web` **n'efface pas** les contrôles navigateur historiques de `recette/` (`parcours*.mjs`, `uiux-check.mjs`, `_suivi-doc-checks.mjs`, captures + `*-checks.json`), qui restent des contrôles de recette, pas des tests unitaires du calcul serveur. | glob `apps/web/**/*.{spec,test}.{ts,tsx}` = 0 ; `apps/web/package.json` sans runner ; `recette/*.mjs` |
| M-10 | Défaut confirmé | **Rate-limit checkout en 404** au lieu de 429 (incohérent avec le endpoint status). | `checkout.service.ts:133-137` |

### 🔵 Risques à vérifier (soupçon, preuve insuffisante — non confirmés)

| # | Gravité | Risque | À vérifier par |
|---|---|---|---|
| R-FAC-01 | Élevée | Singleton `BillingSetting` créé sans contrainte unique → 2 séries sous concurrence → collision `Invoice.number` (P2002) = **achat refusé** (déjà tracé `TASKS.md:1315`) | test de concurrence réelle en base isolée |
| R-CMD-02 | Moyenne | Verrou d'idempotence `FOR UPDATE` conditionnel (C3 + membre) : chemin invité/legacy non couvert explicitement | test de concurrence invité (e2e) |
| R-ABO-03 | Élevée | Suspension admin = simple changement de statut : **à vérifier** si elle arrête réellement les ressources (sinon service gratuit) | décision + test d'effet infra |
| R-WAL-01 | Moyenne | Champ `walletBalanceCents` exposé sans couche de service : risque d'écritures directes hors `$transaction` au premier développement | ADR/revue imposant un service wallet unique |
| R-PAI-04 | Moyenne | `main.ts` sans `rawBody` : la vérification de signature webhook nécessitera l'option `rawBody: true` de NestJS au bootstrap (activation ponctuelle, **pas une refonte**) — modalité exacte à confirmer avec le prestataire choisi | conception du lot C1 (décision §6-1) |
| R-FEE-05 | Basse | Frais de moyen de paiement (`feePercent/feeFixedCents`) modifiables admin mais **jamais appliqués** au calcul | décision : appliquer ou masquer |
| R-AUT-06 | Moyenne | **Pas de switch admin pour l'inscription gratuite** (`free-signup`) alors que l'inscription à la commande en a un | décision + test |
| R-CI-07 | Moyenne | **Aucun CI** (`.github/` absent) : les tests ne s'exécutent pas automatiquement | mise en place pipeline (installation) |

---

## 4. Éléments bloquant le lancement

1. **Encaissement réel** (C-01) : distinguer **fondation** et **adaptateur** — la **machine à états** (`PENDING_PAYMENT → PAYÉ` seulement sur confirmation, états d'annulation/expiry, journal avec acteur) est **indépendante du prestataire** et peut être construite dès le lot **C0** ; seul l'**adaptateur carte** (webhook/signature/session) dépend du choix §6-1. Sans confirmation, toute commande livre gratuitement.
2. **Portefeuille** (C-03) : service unique de solde avec atomicité `$transaction`, `idempotencyKey`, contrôle de droits, historique — **aucune dépendance prestataire** (usage « payer par solde » : branché sur C0).
3. **Recharges** (C-04) : **virement = confirmation manuelle** (dépôt de preuve + validation admin avant crédit) — **indépendante du prestataire** (lot C3a) ; **carte** = webhook signé + anti-rejeu selon prestataire (C1/C3b, voir C-04 pour `rawBody` : option de bootstrap, modalité à confirmer avec le prestataire).
4. **Facturation accessible** (E-02) : consultation client + admin, téléchargement — la promesse post-achat (`success/page.tsx`) est aujourd'hui fausse.
5. **Cohérence tarifaire** (E-01, M-02) : une seule règle promo + un seul arrondi — sinon le prix affiché et le prix payé divergent publiquement.
6. **Renouvellements/échéances** (E-04) : sans scheduler, les abonnements récurrents ne facturent jamais à nouveau.
7. **Remboursements/avoirs** (E-05) : obligation de support/conformité sur un canal marchand.
8. **Récupération de compte** (E-06) : sans reset mdp, chaque mot de passe perdu est un ticket manuel.
9. **Sécurité admin** (C-02) : **prérequis vérifié** — chaîne complète statique + reproduction HTTP 7/7 (401 sans jeton = 0 appel panneau, USER = 200 + appel observé, mutation 403) ; **correctif = lot A0** (`RolesGuard` + `@Roles(ADMIN)` sur les 3 GET) avec le même test en non-régression (USER → 403 et 0 appel panneau).
10. **Visibilité d'exploitation** (E-03, E-07) : listings admin (commandes/factures/clients/paiements) et vues client (« mes commandes / mes factures »).

---

## 5. Lots de correction proposés (ordonnés par dépendances)

> **Ordre calculé (rectifié) :** A0 indépendant (sécurité) → A1/B1/B2 (aucune dépendance technique) → **C0 fondations paiement** (machine à états, **sans prestataire**) → **C2 portefeuille** (sans prestataire ; branchement sur C0) → **C3a recharge virement** (validation manuelle, sans prestataire) → **C1 adaptateur carte** (seul lot dépendant de la décision §6-1) → **C3b recharge carte** (C1+C2) → D1/D2 (dépendent de C0 pour l'état réel) → E1 transverse.
> **Le choix du prestataire n'immobilise que C1/C3b** ; A0, A1, B1, B2, C0, C2, C3a avancent sans lui. Aucun lot n'est commencé : cet ordre est une proposition soumise à arbitrage (§6).

| Lot | Contenu | Dépend de | Critères d'acceptation |
|---|---|---|---|
| **A0 — RBAC immédiat** | `RolesGuard`+`@Roles(ADMIN)` sur les 3 `GET` de `deployment-modules.controller.ts` | — | reprise de la reproduction en non-régression : USER → **403** sur les 3 routes **et 0 appel panneau** ; ADMIN → 200 ; grep `@Get` sans garde = 0 |
| **A1 — Compte client** | Reset mot de passe (email à jeton), édition profil (nom/email), (optionnel : suppression/anonymisation) | — | parcours e2e complet reset ; `PATCH /me` isolé par compte ; aucun mdp dans les logs |
| **B1 — Visibilité** | `GET /client/orders`, `GET /client/invoices` (+ détail), `GET /admin/orders|invoices|customers` + pages `/manager/commandes`, `/manager/factures`, KPI dashboard | — | chaque liste paginée et **filtrée par propriétaire** (client) / ADMIN (admin) ; e2e isolation ; les promesses de `success/page.tsx` deviennent vraies |
| **B2 — Cohérence tarifaire** | Règle promo unique (voir décision §6-2), arrondi serveur unique, re-fetch des prix au panier, admin TaxRate, tests `taxAmountCents ≠ 0` | — | prix affiché = prix débité (test de régression promo + TVA) ; 0 écart client/serveur sur jeu de cas |
| **C0 — Fondations paiement** | Machine à états `PENDING_PAYMENT → PAYÉ` (confirmation serveur requise, états annulé/expiré, journal **avec acteur**), réponse reflétant le **statut réel**, spécification de la **nouvelle intention** d'achat après annulation (E-08 : ni suppression de clé, ni filtre sur statut) | — (**pas de prestataire**) | commande sans confirmation → **aucun provisioning** ; rejeu même intention → 1 commande ; rachat après annulation → 2e commande ; double-clic → 0 doublon |
| **C1 — Intégration carte (adaptateur)** | Prestataire choisi : webhook/`rawBody` (option bootstrap NestJS), signature + anti-rejeu, `Order/Invoice` passés `PAID` seulement à confirmation, journal avec acteur | **§6-1 (décision)** + C0 | test sandbox prestataire : commande non confirmée → 0 provisioning ; webhook rejoué → 1 seule écriture ; signature invalide → 401 |
| **C2 — Portefeuille** | Service wallet unique : `credit/debit` en `$transaction` avec `idempotencyKey`, verrou ligne `Customer`, contrôle propriétaire, historique, endpoint client | C0 (branchement « payer par solde ») — **aucune dépendance prestataire** | tests de concurrence : solde ne passe jamais négatif, double débit impossible, droits refusés ; 0 écriture `walletBalanceCents` hors service (grep) |
| **C3a — Recharge par virement** | Dépôt de preuve + **validation admin avant crédit** + rapprochement — manuel, **sans prestataire** | C2 (crédit) | e2e : preuve refusée → 0 crédit ; validée → solde crédité **1 fois** |
| **C3b — Recharge par carte** | Via l'adaptateur C1 (création de recharge, confirmation webhook, anti-rejeu) + remboursements (`REFUNDED` + avoir) | C1 + C2 | e2e sandbox : recharge → solde crédité 1 fois ; remboursement → avoir cohérent |
| **D1 — Facturation complète** | PDF, **règle de numérotation par exercice (§6-6)**, mentions légales/`dueDate`, consultation téléchargeable (déjà en B1) | C0 (état `UNPAID` réel) | numéro unique sous concurrence (test réel) ; PDF stable ; mentions figées à l'émission |
| **D2 — Abonnements récurrents** | Échéances (`nextBillingDate`), scheduler de renouvellement, dunning, suspension auto à échéance, (upgrade exposé) | C0 (+ C1 pour un re-prélèvement carte, C2 pour le solde) | test horloge accélérée : renouvellement → 2e facture ; impayé → suspension ; **effet infra de la suspension tranché (§6-4)** |
| **E1 — Exploitation** | UI des 5 actions admin, écran moyens de paiement, audit complet (acteur, transitions, frais), CI exécutant unit + e2e | transverse (après A0) | grep : plus d'action admin sans UI ; audit contient acteur sur `payment.checkout` ; pipeline vert |

---

## 6. Décisions nécessitant votre arbitrage

1. **Prestataire de paiement (carte)** — aucun n'est sélectionné ni impliqué ici. À trancher **avant le lot C1 uniquement** : capacités requises = webhook signé, sandbox, remboursement, devise USD. *Sans cette décision : C1/C3b restent BLOQUÉS — **C0, C2, C3a et A0/A1/B1/B2 avancent sans lui**.*
2. **Règle promo** — deux options cohérentes : **(a)** facturer le prix promo (`promoPriceHtCents` devient le prix débité), ou **(b)** supprimer l'affichage barré et ne garder qu'un prix unique. Aujourd'hui : affichage barré + prix plein facturé (incohérent, E-01). Idem pour l'arrondi : imposer la règle serveur et afficher le total serveur.
3. **Périmètre et ordre des lots** — valider l'ordre rectifié §5 (A0 sécurité d'abord, puis A1/B1/B2, puis **C0 → C2 → C3a sans prestataire**, C1 après votre choix) et confirmer que **B1 (visibilité), A1 (reset mdp), C0, C2, C3a partent avant le choix du prestataire**.
4. **Effet d'une suspension d'abonnement** — doit-elle arrêter/suspendre les apps du client (action provider), ou seulement bloquer le renouvellement ? (R-ABO-03 : aujourd'hui, rien n'est arrêté.)
5. **Politique virement** — aujourd'hui le virement est « payé » à l'instant. Décider : **(a)** validation admin + preuve avant livraison (lot C3a, sans prestataire), ou **(b)** livraison immédiate avec facture `UNPAID` puis relance (dunning en D2).
6. **Devise, fiscalité et numérotation** — confirmer USD seul (aucune conversion) et désigner l'endroit d'administration des taux de taxe + des mentions légales (M-01, M-04, M-08) ; trancher la **règle de numérotation par exercice** (remise à zéro annuelle vs séquence continue — M-04, fait ≠ exigence).
7. **Conformité compte** — suppression/anonymisation (RGPD) au lancement ou reportée (M-07) ; switch admin pour l'inscription gratuite (R-AUT-06) ?
8. **Exigence de CI** — rendre obligatoire un pipeline de tests avant chaque merge (R-CI-07), sachant que l'installation d'outillage est une **dépendance → GO dédié** (ressources existantes : `test:e2e` et scripts `test` déjà présents, `.github/` absent).

---

## 7. Preuves mobilisées

### 7.1 Exécutées pendant cet audit (2026-10-02)
- **7 suites / 137 tests unitaires — 137 PASS, 0 ÉCHEC** : `checkout.service.spec`, `checkout-c3.spec`, `checkout.controller.spec`, `order-cancel.service.spec`, `order-terminate.service.spec`, `subscriptions.service.spec`, `audit.service.spec`. **`reconcile*` n'en fait pas partie** (attribution rectifiée — voir §1.3).
- **Environnement** : `npx jest` (unit) dans `apps/api` — mocks en processus, **aucune base, aucun réseau, aucun appel provider** ; exécution 60 s.
- **Reproduction HTTP isolée RBAC — 7/7 PASS (54,9 s)** : spec dédiée exécutée en base **isolée identifiée** `icode_host_pro_c4test` (garde `current_database()`, migrations 48/48 = dépôt), fixtures User/Server/Module créées puis supprimées, **panneau factice local 127.0.0.1** enregistrant les appels (**0 appel sortant**). Résultats : sans jeton → 401 ×3 + **0 appel panneau** ; USER → 200 sur les 3 GET (leak `hostname`/`panelProvider`) + **appel panneau Bearer observé** sur `:id/projects` ; ADMIN → 200 ; USER sur `POST` → 403. *Spec temporaire retirée après exécution (résultats consignés ici ; aucun fichier applicatif touché).*
- **Limites** : les tests unitaires ne valident que la logique sous mocks ; la reproduction HTTP couvre **ces 3 routes uniquement**.

### 7.2 Réutilisées (preuves existantes pertinentes)
- e2e recette (DB de test + transports simulés panel3021/DNS3022/GitHub3023/SMTP3025) : `store-checkout-domains` (2026-09-20, 21 tests), `store-cancel-provisioning` + `store-terminate-active-service` (2026-09-24), `client` isolation (2026-09-25), `c3-*` (2026-09-27), `c4-*` (2026-09-29), `store-order-status` (2026-09-19), `auth-register`/`mfa`/`oauth` (2026-09-02), `impersonation` (2026-09-12), `audit`+`admin` (2026-08-31), `security-settings` (2026-09-21).
- **Limites communes** : non relancées pendant cet audit ; valide l'état des lots antérieurs, pas l'état du jour ; **aucun PASS réel prestataire** n'en découle.
- **Panels réels (nuance rectifiée)** : des interactions panneau réelles **existent historiquement** — env dev connectée à un vrai Coolify (`portal.arumdigital.com`, CLAUDE.md §2), Hestia utilisé pour le suivi de métriques (§4) — **sans valider pour autant le code actuel** de provisioning ; la recette a explicitement évité les builds Coolify réels (`RAPPORT-LOT-B.md:285`).

### 7.3 BLOQUÉS ou non exécutés (prérequis vérifiés, rectification du GO)
| Contrôle | Statut rectifié | Prérequis / ressources vérifiées |
|---|---|---|
| Rejeu e2e complet (DB) | **ressources vérifiées — non exécuté ici** | base **isolée identifiée** `icode_host_pro_c4test` (48/48 migrations = dépôt, connexion vérifiée), `test/jest-e2e.json`, recettes existantes → **aucune migration ni installation requise** ; non exécuté car hors périmètre du GO de consolidation (pas de batterie générale) |
| Tests promo/TVA côté web | **BLOQUÉ (dépendance)** | `apps/web` : ni runner ni fichiers `*.spec/test` (vérifié) → installation jest/vitest = **dépendance → GO dédié** |
| Webhook signature/anti-rejeu | **BLOQUÉ (décision §6-1)** | choix du prestataire + endpoint ; `rawBody` = option de bootstrap NestJS (voir C-04), modalité exacte à confirmer avec le prestataire |
| Concurrence réelle numérotation/solde | **ressources vérifiées — non exécuté ici** | même base isolée + écritures de fixtures **autorisées** ; non exécuté (hors périmètre des 6 points) |
| Suspension d'abonnement → effet infra | **BLOQUÉ (décision §6-4)** | décision sur l'effet attendu + appel provider (interdit ici) |

---

## 8. Livrables et chemins absolus

- Rapport d'audit : `C:\Users\mourad.errabii\Documents\iCode-Host-Recette\docs\audit-socle-commercial.md` (ce fichier)
- Suivi mis à jour : `C:\Users\mourad.errabii\Documents\iCode-Host-Recette\docs\suivi-projet.html` (§15 — étape 1 consignée)
- Statut mis à jour : `C:\Users\mourad.errabii\Documents\iCode-Host-Recette\PROJECT_STATUS.md`

**Aucun fichier applicatif modifié · aucun commit · aucun push · aucune dépendance installée · aucune migration · aucun appel réseau externe.** *Écritures limitées aux fixtures de la reproduction HTTP, en base isolée identifiée `icode_host_pro_c4test`, supprimées en fin de test ; appels limités à une boucle locale 127.0.0.1.*
