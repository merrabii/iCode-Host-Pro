# RAPPORT — GO socle commercial (P0→P10 + corrections consolidées Q-A→Q12 + corrections finales GO P1→P3 + fermeture des fenêtres résiduelles R1→R2)

**Date :** 2026-10-06 · **Branche :** `feat/socle-commercial` (worktree `C:\Users\mourad.errabii\Documents\iCode-Host-Recette`)
**Base de tests :** `icode_host_pro_socle` (docker `icode-postgres`, 60 migrations) · **Base recette UI :** `icode_host_pro_recette` (60 migrations) · **Bases legacy :** `icode_host_pro_c3premig`, `icode_host_pro_c4premig`, `icode_host_pro_c4test`
**Commits :** `git log main..HEAD` = **50 commits** (`86c9f61`→docs GO fenêtres ; corrections finales = `f02f84e` (P1), `11d0ad2` (P2), `e5c56cc` (P3) ; **fenêtres résiduelles = `e3d8f03` (R1 barrière de chaîne), `132dc41` (R2 fraîcheur sous verrou)** ; code testé = `132dc41`) — **aucun push, aucun merge** (`main`/`origin/main` = `3245694` intact).
**Diff complet :** `git diff 3245694 HEAD --binary --full-index` sur HEAD final (couvre les 47 commits ; statistiques exactes et SHA-256 : `recette/GUIDE-RECETTE-P10.md` §6 + `recette/ETAT-REPRISE.md`, hors git, + rapport de sortie du GO — le SHA est calculé après le dernier commit, **sans aucun commit de cachet**).
**Environnement de preuve (toutes capacités ci-dessous, sauf mention contraire) :** local uniquement — docker `icode-postgres`, API Nest sur 3011 (PORT 3001 interdit), web Next sur 3002, proxy nav 3999, comptes `admin-recette@icode.test` (admin), `client-a-recette@icode.test` (client A de consultation), `q10-client@icode.test` (fixture dédiée du parcours Q10). Aucun appel réseau sortant vers un panneau/paiement réel (transports simulés).

---

## 1. Synthèse par capacité (statut · preuve · limite)

Statuts GO : **terminée / partielle / bloquée / non testée**. Aucun « PASS global » : chaque ligne porte sa preuve et sa limite.

| # | Capacité (origine) | Lot | Statut | Preuve principale | Limite / réserve |
|---|---|---|---|---|---|
| 1 | RBAC administration (C-02) | A0 | **terminée** | e2e `rbac-deployment-modules` (USER → 403, 0 appel panneau) ; commit `86c9f61` | — |
| 2 | Récupération mdp oublié + sessions + email vérifié + clôture (E-06, GO 3) | A1/Q-D | **terminée** | e2e `account-recovery` **36/36** : reset CAS concurrence `[201,400]`, double-refresh, `ownedBy`/`ensureOwnedCustomer` stalés, clôture sans touche financière, **famille de sessions par `RefreshToken.sessionId`** (révocation en cascade P1) ; commits `8bd07d3` + `d949f65` | Exécution RGPD/anonymisation = décision owner (§6-7) |
| 3 | Édition profil (`/profil`, pendingEmail) | A1/Q-D | **terminée** | e2e `account-recovery` + page `/profil` + `/auth/verifier-email` | — |
| 4 | Visibilité client/admin : mes commandes, mes factures, listings admin (E-03/E-07) | B1 | **terminée** | e2e `visibility-lists` (15) ; captures P10 | Dashboard home = pages listes (KPI dédié hors périmètre, décision) |
| 5 | Cohérence tarifaire : promo facturée, devis, taux (E-01/M-02) | B2/Q-E | **terminée** | e2e `pricing-consistency` **26/26** (dévis serveur = commande = facture = débit, `PRICING_CHANGED` 409 + ré-acceptation, gratuité 0, frais côté serveur ; **preuve d’acceptation serveur complète 4 champs** `acceptedTotalTtcCents`/`acceptedCurrency`/`acceptedPaymentMethodId`/`acceptedQuoteKey` — omission → 409 `ACCEPTANCE_REQUIRED` + `missing[]` sans écriture, divergences → `TOTAL_MISMATCH`/`CURRENCY_MISMATCH`/`QUOTE_KEY_MISMATCH`, **rejeu d’intention préservé avant refus**) ; commits `9d96a83` + `c498fda` + `323e793` | Décision **§6-2a appliquée** : le prix promo est facturé |
| 6 | Fondations paiement : `PENDING_PAYMENT→PAID`, confirmation serveur, rejeu/annulation (C-01/E-08) | C0 | **terminée** | e2e `store-payment-confirmation` (25) + `store-order-status` (3) + `store-checkout-domains` (21) ; commit `17f1bf2` | Webhook prestataire réel = C1 (bloqué §6-1) |
| 7 | Confirmation avant livraison (virement) | C0/C3a | **terminée** | `confirm-payment` admin → provisioning seulement après confirmation ; e2e concernés verts | — |
| 8 | Portefeuille : solde, idempotence stricte, concurrence, **règlement de commande par solde** (C-03, GO 1+2) | C2/Q-A | **terminée** | e2e `wallet-recharge` (15) + `wallet-payment` **14/14** (double-clic 2×201/1 débit, rejeu même clé, contenu divergent 409, EUR 409, rollback `payment.confirm_failed`) ; boutons « Régler par solde » `/client/commandes`, `/client/factures`, `/checkout/success` ; **parcours navigateur 25/25** (refus solde 0 = 409 puis « Commande payée ») ; commits `d5fdae1` + `076a5ab` | USD uniquement ; rollback = seul compensateur |
| 9 | Recharge par virement + validation admin (C-04, GO 8) | C3a/Q-F | **terminée** | e2e `wallet-recharge` (refusé → 0 crédit ; validé → 1 crédit) ; `bankRef` obligatoire **3..64 + unicité globale** (409 en cas de réutilisation), contenu réel du fichier sniffé (magic bytes), stockage `apps/api/storage/` privé, parcours navigateur (dépôt justificatif + validation prompt) ; commits `ada8bed` | — |
| 10 | Facturation : PDF figé, mentions, échéance, numérotation, statut re-stampé (E-02, GO 8) | D1/Q-F | **terminée** | e2e `invoice-billing` (12) : unicité sous concurrence PG, PDF octet-identique dans un statut, pagination longs documents, régénération si statut changé ; commits `62d68fb` + `ada8bed` | Numérotation **sans remise à zéro annuelle** = décision **§6-6** (réversible) |
| 11 | **Remboursements internes + avoirs** (GO 9) | Q9/Q10 | **terminée** | e2e `refunds-credit-notes` **29/29** (plafond exact ≤ encaissé, idempotence par clé, concurrence 2×10+même clé, avoir cumulatif, RBAC, zéro `SUCCEEDED EXTERNAL_CARD` sans confirmation, **`fullyRefunded` = cumul des `SUCCEEDED`**, **pièces d’avoir numérotées distinctes `CREDIT_NOTE-*` + `allocateCreditLines`**) + `refund.service.spec` 28/28 ; UI « Rembourser (wallet) » sur **PAID et ACTIVE** ; **parcours navigateur : remboursement 5,50 → wallet + avoir AV- émis** ; commits `73a6061` + `3eb0852` + `e6ddb86` + `41cd0b9` | **Confirmation externe réelle** = adaptateur carte → **§6-1 (bloqué)** ; machine `applyExternalConfirmation` = simulation interne étiquetée, jamais exposée admin |
| 12 | Abonnements : échéances, renouvellement par solde, dunning, **consentement**, suspension/réactivation (E-04, GO 4+5) | D2/Q-A/Q-B | **terminée** | e2e `recurring-billing` (**10**) + `wallet-payment` L + `suspension-reactivation` **7/7** + `suspension-resolution` **4/4** (ensemble **11/11** au rejeu final, flag C4 ON) + `suspension-c4` **9/9** (verrous Invoice→Subscription, effets panel `stop/start` post-commit sous `HOSTING_C4_ENABLED`, capacité manquante → `blocked` sans invalider le statut, zéro suppression, réactivation sans double facture, **résolution abonnement→service/app au checkout `subscriptionId`**, **barrières fail-closed P3** : fraîcheur `decision_perimee`, OFF `protocole_off` sans appel réseau, scope SERVICE opposable, settle `REFUSED`/inconditionnel) ; toggle **Activer/Révoquer** consentement daté ; gate renouvellement strict **en TX de débit (P2)** + `lockAuthIdentity` sur les flux de jetons (P1) ; **fenêtres résiduelles R1/R2** : barrière advisory commune création/révocation (`chain-revocation-barrier` **2/2**) + fraîcheur sous verrou `FOR UPDATE` en tx de tentative (`suspension-c4` **11/11**) ; commits `d8b55e4`, `076a5ab`, `3fbbf62`, `5f06913`, `4d56377`, `11d0ad2`, `e5c56cc`, `e3d8f03`, `132dc41` | Effet **sur l'infra live** = arrêt exact des apps à trancher (**§6-4**) ; §6-2a tarif renouvellement conforme |
| 13 | Timers de sweep : activation explicite, prérequis schéma, invariants multi-processus (GO 6) | Q-C | **terminée** | e2e `sweep-timers` **4/4** (config absente → aucun timer/aucune mutation ; lease tenu → refus ; 2 instances concurrentes → 1 seule expiration + 1 audit) ; défaut **OFF strict `=== 'true'`**, lease `SweepLease` TTL 180 s ; commit `2f3948c` | `.env` local non modifié (timers éteints en dev) ; activation documentée dans `.env.example` |
| 14 | Exploitation : UI des 5 actions admin (M-06) | E1 | **terminée** | capture `socle-p10-manager-commandes-detail-actions.png` + e2e `audit-completeness` | — |
| 15 | Écran moyens de paiement + **frais réellement appliqués** (M-06, GO 7) | E1/Q-E | **terminée** | capture `socle-p10-manager-moyens-paiement.png` ; `buildPricing(method)` = frais en ADJUSTMENT non taxée figés Order+Invoice, devis public les expose, badge = devis serveur ; commit `c498fda` | Ancien constat « frais seulement journalisés » **corrigé par Q-E** ; affichage client = devis (badge = grille indicative) |
| 16 | Audit complet : acteur, transitions, frais (M-05) | E1 | **terminée** | e2e `audit-completeness` (5/5) ; audits `refund.*`, `suspension.*`, `auth.*` ajoutés | `payment.checkout.error` garde l'acteur créateur |
| 17 | **Suites e2e legacy 17B** (`c3-premig`, `c4-premig`, `c4-release`, `c4-rollback`) | Q10a | **terminée** | **39/39 PASS** sur 3 bases dédiées refabriquées (`c3premig` = 60 migrations + DROP tables C1/C3/C4, `c4premig` = 60/60 sans C4 **+ DROP des 5 tables C4 restaurant les préconditions CI (P6)**, `c4test` complète partagée release/rollback) ; scénarios pré-migration intacts, garde `current_database()` ; **réintégrées en CI** (étapes dédiées + **étape « Préconditions effectives des bases legacy »** miroir `current_database()`/`to_regclass`) ; commits `3eb0852` + `8f44824` | Bases **regénérées à chaque run CI** (aucun dump binaire committé) |
| 18 | **`next build`** (GO 10) | Q10b | **terminée** | `NODE_OPTIONS=--max-old-space-size=6144 npx next build` → **EXIT 0** (cause racine = OOM du heap V8 par défaut, pas de la RAM machine) ; étape CI dédiée ajoutée ; **ré-exécution sur le code Q12 → EXIT 0** (`final-q11-next-build.log`) ; commit `3eb0852` | Routage/tsc = validation quotidienne ; `next build` en CI + avant release |
| 19 | **Parcours navigateur réels** : droits, achat par solde, recharge/validation, refus, renouvellement, remboursement (GO 10) | Q10d | **terminée** | `powershell -File recette\test-q10.ps1` = **25/25 PASS** (19 captures `recette/q10-*.png` + `q10-checks.json`) : droits client refusé `/manager`, boutique→panier→paiement→success, refus solde 0, justificatif déposé, validation admin (prompt `bankRef`), règlement par solde → « Commande payée », armer/révoquer renouvellement, refus plafond (« dépasse le total encaissé »), remboursement → « + avoir émis », après-coups portefeuille et factures `AV-` + **garde `current_database()`, fixture dédiée Q10, identité API↔Prisma** (item 4) ; **exécuté 2 fois** (création fixture + « existant + marqueur vérifié ») | Exécuté sur `next dev` (profil Edge dédié) ; scripts/preuves hors git (`recette/`) |
| 20 | Déclenchement du pipeline CI GitHub (exécution réelle) | E1/Q10 | **non testée** | `.github/workflows/ci.yml` lint OK ; étapes **équivalentes exécutées en local** (typecheck×2, unit, e2e, legacy, next build) | Push interdit par le GO → le pipeline n'a jamais été exécuté sur GitHub |
| 21 | Adaptateur carte (webhook/signature) | C1 | **bloquée** | — | Décision **§6-1** (prestataire) non rendue |
| 22 | Recharge par carte + remboursement carte réel (`EXTERNAL_CARD` confirmé) | C3b | **bloquée** | — | Dépend C1 (§6-1) ; fondations internes (liens/plafonds/idempotence) = terminées en 11 |
| 23 | Suppression/anonymisation RGPD (M-07) + switch admin inscription gratuite (R-AUT-06) | — | **non testée** | — | Décisions owner (§6-7) ; la **demande** de clôture (tracée, sans exécution) = terminée en 2 |

**Ce que la table ne prétend PAS :** aucune ligne ne couvre un prestataire réel, une mise en production, un push ou une activation commerciale.

---

## 2. Résultats finaux (commandes · logs · bases · commit testé)

**Commit testé :** `e5c56cc` (dernier commit de code, corrections finales P3 ; l'exécution consolidée a couru sur cet arbre + les futures docs). Exécution consolidée unique du **06/10/2026** (script `recette/final-validation-q11.ps1` inchangé, logs `recette/logs/final-q11-*.log` refaits + récapitulatif `final-gofinal-summary.txt`) :

| Étape | Commande (cwd) | Base | Résultat | Log |
|---|---|---|---|---|
| Typecheck API | `npx tsc --noEmit -p tsconfig.json` (`apps/api`) | — | **PASS** | `final-q11-tsc-api.log` |
| Build API | `npx nest build` (`apps/api`) | — | **PASS** | `final-q11-nest-build.log` |
| Unit complet | `npx jest src --maxWorkers=4` (`apps/api`) | — | **1225/1225 PASS — 65 suites** | `final-q11-unit.log` |
| e2e complet | `npx jest --config ./test/jest-e2e.json --runInBand --testPathIgnorePatterns c3-premig c4-premig c4-release c4-rollback` (`apps/api`) | `icode_host_pro_socle` | **525/525 PASS — 46 suites** | `final-q11-e2e.log` |
| e2e legacy (3) | idem avec `DATABASE_URL` = base dédiée + `--testPathPattern` | `icode_host_pro_c3premig` / `icode_host_pro_c4premig` / `icode_host_pro_c4test` | **39/39 PASS** (3 + 3 + 33) | `final-q11-legacy-*.log` |
| Typecheck Web | `npx tsc --noEmit -p tsconfig.json` (`apps/web`) | — | **PASS** | `final-q11-tsc-web.log` |
| Build Web | `NODE_OPTIONS=--max-old-space-size=6144 npx next build` (`apps/web`) | — | **EXIT 0** | `final-q11-next-build.log` |
| Parcours navigateur | `powershell -File recette\test-q10.ps1` | `icode_host_pro_recette` | **25/25 PASS** (1ʳᵉ exécution création fixture Q10 + 2ᵉ exécution consolidation « existant + marqueur vérifié »), exit 0 | `recette/q10-checks.json` |
| Lint CI | `pnpm dlx js-yaml .github/workflows/ci.yml` | — | PASS (Q12) ; **lint ESLint local non exécutable** (binaire absent du checkout — voir §7) | — |

Logs de référence antérieurs : `recette/logs/final-q11-*.log` (Q11/Q12), `recette/logs/e2e-final-p10*.log` (P10).

**Validation ciblée du GO « fenêtres résiduelles » (06/10/2026, sur `132dc41`, adaptée = batteries ciblées, preuves du GO final encore valables pour le reste)** :

| Étape | Résultat |
|---|---|
| Typecheck API `npx tsc --noEmit -p tsconfig.json` | **PASS** (exit 0) |
| Unit complet `npx jest src --maxWorkers=4` | **1226/1226 PASS — 65 suites** (+1 : garde `decision_perimee` sous verrou) |
| e2e ciblé `--testPathPattern '(renewal\|recurring\|chain\|sweep-timers\|suspension)'` | **43/43 PASS — 7 suites** (dont `chain-revocation-barrier` **2/2** nouvelle, `suspension-c4` **11/11**) |
| e2e `wallet-payment` (exerce la voie révocation R1) | **14/14 PASS** |
| e2e legacy 3 bases dédiées (garde `db-guard.mjs <base>` avant chaque suite) | **39/39 PASS** (3 + 3 + 33) |

Non rejoués ce GO (réutilisation des preuves valables du GO final : aucune écriture web, aucun changement legacy comportemental — paramètre de garde opt-in) : e2e principal complet (525/525 du GO final), typecheck web, `nest build`, `next build`, parcours navigateur 25/25, lint ESLint local non exécutable (§7).

---

## 2bis. Corrections consolidées Q12 (revue du patch final — 7 points GO)

Chaque point = une revue du patch `3245694`→HEAD ; **zéro assertion affaiblie** (fixtures/contrats adaptés : 8 suites e2e + mock unit `checkout-pricing`).

| # | Point relevé | Correction | Preuve | Commit |
|---|---|---|---|---|
| P1 | Refresh tokens non rattachés à une session (révocation non familiale) | `RefreshToken.sessionId` + migration `20261006000000_q12_refresh_session_family` ; révocation en cascade par famille/session | unit auth **135/135** ; e2e `account-recovery` **36/36** | `d949f65` |
| P2 | Renouvellement armé sans garde-fou ; débit solde non protégé | gate renouvellement strict **sans fallback**, révocation en cascade, **CAS wallet avant débit** | `recurring-billing` **10/10** ; unit wallet/renewal | `5f06913` |
| P3 | Checkout sans lien abonnement → effets panel impossibles | `subscriptionId` au checkout, résolution **abonnement→service/app**, dispatch `UNKNOWN` si introuvable | `suspension-resolution` **4/4** + `suspension-c4` **5/5** | `4d56377` |
| P4 | `fullyRefunded` basé sur un seul remboursement | **cumul des `SUCCEEDED`** (`refund.service.ts`) | `refund.service.spec` **28/28** + e2e 29/29 | `e6ddb86` |
| P5 | Avoirs sans pièce numérotée ni allocation ordonnée | pièces `CREDIT_NOTE-*` distinctes, `allocateCreditLines`, migration `20261006000001_q12_p5_credit_note_pieces` | e2e `refunds-credit-notes` **29/29** | `41cd0b9` |
| P6 | Préparation CI legacy incomplète (`c4premig` sans DROP C4) | DROP des 5 tables C4 pour `c4premig` + étape **« Préconditions effectives des bases legacy »** (miroir `current_database()`/`to_regclass`) | `pnpm dlx js-yaml` PASS + étape exécutée en local | `8f44824` |
| P7 | Checkout accepté sans preuve d’acceptation complète ; rejeu après tarif échu rejeté à tort | DTO 4 champs `accepted*`, module `pricing-acceptance` (empreinte `pricingQuoteKey`), **gate 6b après résolution d’intention** (rejeu avant refus), `baseKey = acceptedTotalTtcCents ?? amountTtcCents`, gratuité 0 aussi contrôlée | `pricing-consistency` **26/26** (C1–C6, C5b/C5c, D1–D6) + parcours navigateur 22/22 | `323e793` |

---

## 2ter. Corrections finales GO (06/10/2026 — P1→P3 + outillage recette)

Suite de Q12 : trois défauts transactionnels/fail-closed relevés par le GO « corrections finales ciblées », plus la sécurisation de l'outillage de recette. **Zéro assertion affaiblie ; aucun nouveau lot fonctionnel.**

| # | Point relevé | Correction | Preuve | Commit |
|---|---|---|---|---|
| P1 | Refresh/rotation/logout non verrouillés : une révocation ou un reset concurrent pouvait échapper une rotation de jeton (course identité/jetons) | `lockAuthIdentity(tx, userId)` exécuté dans **la même transaction** que rotation refresh, reissue, logout, changement de mot de passe, reset de mot de passe et `issueTokens` (création de famille) | unit `auth.service.spec` **48/48** ; e2e `auth-refresh-serialization` **7/7** (nouvelle) ; `account-recovery` **36/36** | `f02f84e` |
| P2 | Consentement et éligibilité vérifiés **hors** transaction de débit (TOCTOU) ; CAS `autoRenew` du renouvellement affaibli | `renewalChargeGateInTx` appelé dans la TX de débit du checkout (après la branche de rejeu ; `payOrderWithWallet` → `confirmOrderInTx` sans opts) ; CAS `autoRenew` **supprimé** (la gate en TX fait foi) | e2e `renewal-consent-in-tx` **5/5** (nouvelle, helper `makeMother`) ; régression `recurring-billing` + `wallet-payment` + `store-payment-confirmation` **49/49** ; unit renewal/subscriptions **54/54** | `11d0ad2` |
| P3 | Suspension C4 : effets live possibles sous OFF, décisions périmées acceptées, arrêts de scope SERVICE non opposables, settle partiel | Mode (`c4`/`off`) figé au **démarrage** du passage ; fraîcheur LIVE `subscription.status` avant toute préparation → `decision_perimee` ; garde OFF → `protocole_off` (**aucun appel réseau, zéro table C4**) ; `serviceId` au `beginDispatch` (allocation/déploiement) → arrêts SERVICE opposables ; settle `REFUSED` post-begin si OFF ; settle **inconditionnel** après réponse | unit `suspension-effects` **21/21** (défaut ON + describe « barrières ») ; e2e `suspension-c4` **9/9** (nouvelles : ON→OFF mid-préparation, réponse après OFF, scope SERVICE, décision périmée) ; `suspension-resolution` + `suspension-reactivation` **11/11** (flag ON + nettoyage C4) ; legacy `c4-release/rollback` **33/33** | `e5c56cc` |
| Outillage (item 4) | `parcours-q10` réinitialisait le compte A de la recette ; aucune garde `current_database()` ; tests lancés avec la commande de consultation | **Fixture dédiée Q10** `q10-client@icode.test` (marqueur « Client Q10 (fixture dédiée » ; compte existant **sans** marqueur → reset **REFUSÉ**) ; A/B/C jamais touchés (commandes, soldes, allocations, tentatives) ; **garde `current_database()`** dans `lib.mjs`/`db-guard.mjs`/parcours (base `icode_host_pro_recette` exigée avant toute mutation) ; **identité API↔Prisma prouvée par croisement** (marqueur Prisma relu par `GET /users/me` + RefreshToken API relu via Prisma, pas un simple HTTP 200) ; `test-q10.ps1` = commande de **tests** (health + garde + parcours, ne relance jamais la stack), `up-p10.ps1` = **consultation seule** (audit : aucun reset/seed/test) | parcours **25/25** ×2 (création puis « existant + marqueur vérifié »), `db-guard` OK ; logs `recette/logs/final-gofinal-summary.txt` | hors git (`recette/` exclu) |

---

## 2quater. Fermeture des deux fenêtres résiduelles du patch final (GO fenêtres R1→R2 + outillage, 06/10/2026)

Suite directe du GO final : les deux fenêtres signalées en revue du patch `3245694`→`44eb05e`, fermées **par barrière explicite et test déterministe** (jamais `Promise.all` ni une temporisation supposant l'ordre ; zéro assertion affaiblie ; aucun nouveau lot fonctionnel).

| # | Fenêtre | Barrière mise en place | Preuve déterministe | Commit |
|---|---|---|---|---|
| R1 | **Création de descendants vs révocation de chaîne** : la révocation (`setMyOrderRenewal`, branche `enabled=false`) marchait la descendance puis lançait un `updateMany` séparé — une fille G committée entre les deux n'était ni vue ni désarmée (restait `autoRenew=true` → un sweep ultérieur la débiterait) | `renewal-chain-barrier.ts` : `pg_advisory_xact_lock(hashtextextended(racine, 0))` sur la **racine de la chaîne** (`renewsOrderId` remonté, garde 50), acquise **EN PREMIER** dans la tx des deux voies (`createRenewalOrderInTx` et le walk+cascade en `$transaction`) — ordre identique des deux côtés ⇒ pas de deadlock ; racine append-only ⇒ lecture stable. Le paiement manuel et l'idempotence des CAS restent hors barrière. (Bug trouvé au passage : `pg_advisory_xact_lock()` renvoie `void` — cast `::text` requis pour Prisma `$queryRaw`.) | e2e **`chain-revocation-barrier` 2/2** (nouvelle) : **ordre 1** (création en vol tenue par un gate dans la tx → révocation **constatée en attente** via `pg_locks` `locktype='advisory' AND granted=false` → commit → F **et** G désarmés, audit `revokedDescendants=1`, sweep `created:0 paid:0` sans débit, règlement manuel de G toujours ouvert sans réarmement, révocation idempotente) ; **ordre 2** (révocation d'abord → création sous barrière CAS COUNT 0 → `null`, zéro fille) ; régression `wallet-payment` **14/14** + `recurring-billing`/`renewal-consent-in-tx` verts | `e3d8f03` |
| R2 | **Décision de suspension périmée** : la fraîcheur était lue à l'entrée du dispatch puis réutilisée dans la tx d'enregistrement de la tentative — une transition committée entre les deux pouvait laisser émettre une tentative périmée (verrou de ligne non repris dans la tx) | `freshnessGuard { subscriptionId, expected }` exécuté **première statement** de `beginDispatch` (tx) : `SELECT "status" FROM "Subscription" WHERE id=$1 FOR UPDATE` — statut ≠ attendu ⇒ `ConflictException('decision_perimee: …')` **avant toute tentative/appel**, sous le même verrou que `updateSubscription` (autorité partagée) ; conflit mappé en `decision_perimee` (sinon `c4_refuse`) ; lecture d'entrée = chemin rapide, garde in-tx = autorité ; appelants tiers sans garde inchangés (paramètre opt-in) | unit `suspension-effects` **+1** (`decision_perimee` détectée SOUS VERROU → zéro transport, zéro tentative, audit `decision_perimee`) ; e2e `suspension-c4` **11/11** : **scénario 10** (stop figé AVANT sa tx → réactivation ACTIVE commit pendant → libération ⇒ garde `FOR UPDATE` voit ACTIVE ≠ SUSPENDED ⇒ `decision_perimee`, **zéro tentative, zéro transport**, relance réussie, sub ACTIVE) et **scénario 11** (ordre inverse : tentative d'arrêt déjà **DISPATCHED** en vol ⇒ réactivation fraîche **refusée `c4_refuse`**, settle `SUCCESS` tardif accepté, puis reprise complète) ; scénario 9 préexistant (10 sur `decision_perimee`) toujours vert | `132dc41` |
| Outillage (item 3) | Bloc « Manuellement » du guide sans positionnement de base ni garde entre suites ; `db-guard.mjs` verrouillé sur la seule base recette | `db-guard.mjs` **paramétrable** `node db-guard.mjs <base>` (lit `process.env.DAMESPACE_URL`, exige `current_database()` = base annoncée, sortie 1 sinon ; **sans argument = comportement historique inchangé**, appel de `test-q10.ps1` intact) ; guide §2 : `$env:DATABASE_URL` explicite + garde + `throw` avant chacune des 4 suites e2e, puis remise à zéro de la variable | 4 modes vérifiés (recette OK / socle OK / base inattendue → exit 1 / URL absente → exit 1) + exécution réelle des 3 suites legacy avec garde → **39/39** | hors git (`recette/`) |

**Fichiers de revue fournis (hors git, chemins absolus)** : `C:\Users\mourad.errabii\Documents\iCode-Host-Recette\recette\parcours-q10.mjs`, `…\recette\lib.mjs`, `…\recette\test-q10.ps1`, `…\recette\db-guard.mjs`, `…\recette\up-p10.ps1`.

---

## 3. Preuves visuelles et parcours

- **11 captures** `recette/socle-p10-*.png` (listing admin, **panneau Actions administrateur**, **moyens de paiement**, taxe, facturation, factures, abonnements, recharges, portefeuille, mes factures, mes commandes).
- **19 captures** `recette/q10-*.png` + `recette/q10-checks.json` : parcours complet achat/réappro/renouvellement/remboursement (**25 checks** depuis l'item 4 : 22 historiques + garde base + fixture dédiée + identité API↔Prisma).
- Rejeu : `powershell -File recette\up-p10.ps1` (**consultation**, aucun test/reset/seed) puis `node recette\capture-socle-p10.mjs` / `powershell -File recette\test-q10.ps1` (**tests**, séparés ; voir `recette/GUIDE-RECETTE-P10.md`). Arrêt : `recette\down.ps1`.

---

## 4. Migrations, dépendances, fichiers (GO 11.5)

- **Migrations ajoutées : 12 additives** (aucune ancienne modifiée ; total **48 → 60**) : `20261002000000_add_payment_confirmation`, `20261002100000_add_password_reset`, `20261003000000_add_invoice_billing_terms`, `20261003000001_add_invoice_dunning`, `20261004045500_q_a_renewal_consent_invoice_subscription`, `20261004045643_q_a_index_invoice_subscription`, `20261004104124_q6_sweep_lease`, `20261004114140_q3_email_change_closure`, `20261005000001_q8_wallet_bankref_invoice_pdfstatus`, `20261005000002_q9_refunds_credit_notes`, `20261006000000_q12_refresh_session_family`, `20261006000001_q12_p5_credit_note_pieces`.
- **Dépendances ajoutées (2)** : `pdfkit` + `@types/pdfkit` (PDF facture) — `pnpm-lock.yaml` à jour.
- **Commits : 50** (code = 41 jusqu’à `323e793` + docs Q12 `562fc39` + cachet `3e826a9` + **corrections finales `f02f84e`/`11d0ad2`/`e5c56cc`** + docs GO final + **fenêtres `e3d8f03`/`132dc41`** + docs GO fenêtres) — liste exacte : `git log --oneline main..HEAD` (feature = `076a5ab`, `3fbbf62`, `2f3948c`, `8bd07d3`, `c498fda`, `ada8bed`, `73a6061`, `3eb0852` ; corrections Q12 = `d949f65` (P1), `5f06913` (P2), `4d56377` (P3), `e6ddb86` (P4), `41cd0b9` (P5), `8f44824` (P6), `323e793` (P7) ; **corrections finales GO = `f02f84e` (P1), `11d0ad2` (P2), `e5c56cc` (P3)** ; **fenêtres résiduelles = `e3d8f03` (R1), `132dc41` (R2)** ; tests/docs = commits `test(*)`, `docs(*)` ; le reste = P0→P10).
- **Fichiers modifiés** : détails `git diff --stat 3245694 HEAD` (le patch complet inclut les nouveautés ; statistiques exactes dans le guide/état hors git). Nouveaux services notables : `RenewalService`, `InvoicePdfService`, `WalletService`, `RefundService`, `SuspensionEffectsService`, `sweep-guards`, module `pricing-acceptance` (preuve d’acceptation checkout) ; pages `/client/{commandes,factures,portefeuille}`, `/manager/{commandes,factures,facturation,taxe,recharges,moyens-paiement,subscriptions}`.
- **CI** : `.github/workflows/ci.yml` — typecheck×2, unit, e2e principal, **étape next build (heap 6144)**, **étapes bases dédiées + 3 suites legacy**, **préparations legacy P6** (DROP 5 tables C4 sur `c4premig` + étape « Préconditions effectives des bases legacy »).

---

## 5. Livrables de revue (GO 11.1–11.3, 11.6)

1. **Rapport (ce fichier)** : `docs/RAPPORT-SOCLE-COMMERCIAL.md`.
2. **HTML de suivi actualisé** : `docs/suivi-projet.html` (v11, ouverture locale + navigation vérifiées).
3. **Patch complet depuis `3245694`** : `recette/diff-socle-commercial.patch` — **régénéré sur HEAD final** par `git diff 3245694 HEAD --binary --full-index --output=…` : couvre les **50 commits** (`3245694`→HEAD, nouveautés incluses), écriture par Git lui-même (**aucune redirection d'encodage**). Statistiques exactes et SHA-256 : `recette/GUIDE-RECETTE-P10.md` §6 + `recette/ETAT-REPRISE.md` (hors git) + rapport de sortie — le SHA est calculé **après le dernier commit, sans aucun commit de cachet** (choix explicite du GO final : le modèle « cachet auto-référent hors patch » de Q12 est abandonné).
4. **Vérification de fidélité (corruption d'export vs corruption source)** :
   - *Export* : deux exports successifs → **SHA-256 identiques** (export déterministe, non corrompu).
   - *Source* : `git apply --check --reverse` du patch contre HEAD final → **exit 0** (le patch est exactement reproductible des blobs Git ; tout écart blob/arbre aurait fait échouer le reverse-apply).
5. **Guide court de recette manuelle** : `recette/GUIDE-RECETTE-P10.md` (mise à jour Q10/Q11/Q12 + item 4 : fixtures dédiées, garde, séparation consultation/tests + **GO fenêtres : validation ciblée, `db-guard` paramétrable et bloc « Manuellement »**).
6. **Commit/états** : `git status` propre ; `main`/`origin/main` = `3245694` intact.

---

## 6. Décisions réellement restantes (arbitrage owner — GO 11.7)

1. **§6-1 prestataire de paiement** → **C1 (adaptateur carte) et C3b (recharge + remboursement carte réels) restent bloqués**. Tout le reste du socle (fondations internes de remboursement, confirmation externe simulée étiquetée, paiement par solde, virement) est **terminé et testé** — la décision n'a pas été reclassée hors périmètre.
2. **§6-4 effet infrastructure exact de la suspension** → stop/start des apps via `PanelTransport` implémenté et testé en simulation (C4) ; **l'arrêt réel sur le panel live à activer en production** reste à trancher.
3. **§6-6 numérotation par exercice** → pas de remise à zéro annuelle aujourd'hui (`AAAA-seq` continu) ; trancher avant facturation en prod (réversible).
4. **§6-7 exécution RGPD** (suppression/anonymisation) **+ switch admin d'inscription gratuite** → non tranchés ; la demande de clôture avec tracé est terminée (exécution = décision).

*(Aucune autre décision ouverte : frais **appliqués** (Q-E), « payer par solde » **câblé** (Q-A), suites legacy **restaurées** (Q10a), `next build` **résolu** (Q10b), revue du patch **corrigée de bout en bout** (Q12/P1→P7 — aucune décision §6 n’a été reclassée).)*

---

## 7. Ce que ce rapport NE dit PAS

Aucune mise en production, aucun push/merge, aucun prestataire réel, aucun appel réseau sortant vers un panneau/DNS/paiement réel (simulations en recette), aucune activation commerciale. **Limites d'exécution** : lint ESLint local **non exécutable** (binaire absent de ce checkout — préexistant, équivalent local = typechecks API/Web verts + étape lint CI documentée) ; pipeline GitHub non déclenché (push interdit). **ARRÊT ici pour revue globale unique** (GO item 11) : le statut = **branche locale prête pour revue**, à rejouer avec `recette/GUIDE-RECETTE-P10.md` (recette laissée accessible sur `http://localhost:3002`).
