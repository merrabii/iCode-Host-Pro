# RAPPORT — GO socle commercial (P0→P10 + correction/achèvement Q-A→Q11)

**Date :** 2026-10-05 · **Branche :** `feat/socle-commercial` (worktree `C:\Users\mourad.errabii\Documents\iCode-Host-Recette`)
**Base de tests :** `icode_host_pro_socle` (docker `icode-postgres`, 58 migrations) · **Base recette UI :** `icode_host_pro_recette` (58 migrations) · **Bases legacy :** `icode_host_pro_c3premig`, `icode_host_pro_c4premig`, `icode_host_pro_c4test`
**Commits :** `git log main..HEAD` = **34 commits** (`86c9f61`→`5084864` + cachet docs final ; code testé = `3eb0852`, docs Q10 = `20b2dc5`, docs Q11 = `5084864`) — **aucun push, aucun merge** (`main`/`origin/main` = `3245694` intact).
**Diff complet :** `git diff 3245694 5084864` = **128 fichiers, +27 383 / −452** (patch : `recette/diff-socle-commercial.patch`, 1 470 716 octets, couvre **33 commits** — le seul commit hors patch est le cachet docs final qui rapporte son SHA, auto-référence non composable sans récursion).
**Environnement de preuve (toutes capacités ci-dessous, sauf mention contraire) :** local uniquement — docker `icode-postgres`, API Nest sur 3011 (PORT 3001 interdit), web Next sur 3002, proxy nav 3999, compte `admin-recette@icode.test` / `client-a-recette@icode.test`. Aucun appel réseau sortant vers un panneau/paiement réel (transports simulés).

---

## 1. Synthèse par capacité (statut · preuve · limite)

Statuts GO : **terminée / partielle / bloquée / non testée**. Aucun « PASS global » : chaque ligne porte sa preuve et sa limite.

| # | Capacité (origine) | Lot | Statut | Preuve principale | Limite / réserve |
|---|---|---|---|---|---|
| 1 | RBAC administration (C-02) | A0 | **terminée** | e2e `rbac-deployment-modules` (USER → 403, 0 appel panneau) ; commit `86c9f61` | — |
| 2 | Récupération mdp oublié + sessions + email vérifié + clôture (E-06, GO 3) | A1/Q-D | **terminée** | e2e `account-recovery` **35/35** : reset CAS concurrence `[201,400]`, double-refresh, `ownedBy`/`ensureOwnedCustomer` stalés, clôture sans touche financière ; commit `8bd07d3` | Exécution RGPD/anonymisation = décision owner (§6-7) |
| 3 | Édition profil (`/profil`, pendingEmail) | A1/Q-D | **terminée** | e2e `account-recovery` + page `/profil` + `/auth/verifier-email` | — |
| 4 | Visibilité client/admin : mes commandes, mes factures, listings admin (E-03/E-07) | B1 | **terminée** | e2e `visibility-lists` (15) ; captures P10 | Dashboard home = pages listes (KPI dédié hors périmètre, décision) |
| 5 | Cohérence tarifaire : promo facturée, devis, taux (E-01/M-02) | B2/Q-E | **terminée** | e2e `pricing-consistency` **18/18** (dévis serveur = commande = facture = débit, `PRICING_CHANGED` 409 + ré-acceptation, gratuité 0, frais côté serveur) ; commits `9d96a83` + `c498fda` | Décision **§6-2a appliquée** : le prix promo est facturé |
| 6 | Fondations paiement : `PENDING_PAYMENT→PAID`, confirmation serveur, rejeu/annulation (C-01/E-08) | C0 | **terminée** | e2e `store-payment-confirmation` (25) + `store-order-status` + `store-checkout-domains` ; commit `17f1bf2` | Webhook prestataire réel = C1 (bloqué §6-1) |
| 7 | Confirmation avant livraison (virement) | C0/C3a | **terminée** | `confirm-payment` admin → provisioning seulement après confirmation ; e2e concernés verts | — |
| 8 | Portefeuille : solde, idempotence stricte, concurrence, **règlement de commande par solde** (C-03, GO 1+2) | C2/Q-A | **terminée** | e2e `wallet-recharge` (12) + `wallet-payment` **14/14** (double-clic 2×201/1 débit, rejeu même clé, contenu divergent 409, EUR 409, rollback `payment.confirm_failed`) ; boutons « Régler par solde » `/client/commandes`, `/client/factures`, `/checkout/success` ; **parcours navigateur 22/22** (refus solde 0 = 409 puis « Commande payée ») ; commits `d5fdae1` + `076a5ab` | USD uniquement ; rollback = seul compensateur |
| 9 | Recharge par virement + validation admin (C-04, GO 8) | C3a/Q-F | **terminée** | e2e `wallet-recharge` (refusé → 0 crédit ; validé → 1 crédit) ; `bankRef` obligatoire **3..64 + unicité globale** (409 en cas de réutilisation), contenu réel du fichier sniffé (magic bytes), stockage `apps/api/storage/` privé, parcours navigateur (dépôt justificatif + validation prompt) ; commits `ada8bed` | — |
| 10 | Facturation : PDF figé, mentions, échéance, numérotation, statut re-stampé (E-02, GO 8) | D1/Q-F | **terminée** | e2e `invoice-billing` (11) : unicité sous concurrence PG, PDF octet-identique dans un statut, pagination longs documents, régénération si statut changé ; commits `62d68fb` + `ada8bed` | Numérotation **sans remise à zéro annuelle** = décision **§6-6** (réversible) |
| 11 | **Remboursements internes + avoirs** (GO 9) | Q9/Q10 | **terminée** | e2e `refunds-credit-notes` **27/27** (plafond exact ≤ encaissé, idempotence par clé, concurrence 2×10+même clé, avoir cumulatif, RBAC, zéro `SUCCEEDED EXTERNAL_CARD` sans confirmation) + `refund.service.spec` 22/22 ; UI « Rembourser (wallet) » sur **PAID et ACTIVE** ; **parcours navigateur : remboursement 5,50 → wallet + avoir AV- émis** ; commits `73a6061` + `3eb0852` | **Confirmation externe réelle** = adaptateur carte → **§6-1 (bloqué)** ; machine `applyExternalConfirmation` = simulation interne étiquetée, jamais exposée admin |
| 12 | Abonnements : échéances, renouvellement par solde, dunning, **consentement**, suspension/réactivation (E-04, GO 4+5) | D2/Q-A/Q-B | **terminée** | e2e `recurring-billing` (9) + `wallet-payment` L + `suspension-reactivation` **7/7** (verrous Invoice→Subscription, effets panel `stop/start` post-commit sous `HOSTING_C4_ENABLED`, capacité manquante → `blocked` sans invalider le statut, zéro suppression, réactivation sans double facture) ; toggle **Activer/Révoquer** consentement daté ; commits `d8b55e4`, `076a5ab`, `3fbbf62` | Effet **sur l'infra live** = arrêt exact des apps à trancher (**§6-4**) ; §6-2a tarif renouvellement conforme |
| 13 | Timers de sweep : activation explicite, prérequis schéma, invariants multi-processus (GO 6) | Q-C | **terminée** | e2e `sweep-timers` **4/4** (config absente → aucun timer/aucune mutation ; lease tenu → refus ; 2 instances concurrentes → 1 seule expiration + 1 audit) ; défaut **OFF strict `=== 'true'`**, lease `SweepLease` TTL 180 s ; commit `2f3948c` | `.env` local non modifié (timers éteints en dev) ; activation documentée dans `.env.example` |
| 14 | Exploitation : UI des 5 actions admin (M-06) | E1 | **terminée** | capture `socle-p10-manager-commandes-detail-actions.png` + e2e `audit-completeness` | — |
| 15 | Écran moyens de paiement + **frais réellement appliqués** (M-06, GO 7) | E1/Q-E | **terminée** | capture `socle-p10-manager-moyens-paiement.png` ; `buildPricing(method)` = frais en ADJUSTMENT non taxée figés Order+Invoice, devis public les expose, badge = devis serveur ; commit `c498fda` | Ancien constat « frais seulement journalisés » **corrigé par Q-E** ; affichage client = devis (badge = grille indicative) |
| 16 | Audit complet : acteur, transitions, frais (M-05) | E1 | **terminée** | e2e `audit-completeness` (5/5) ; audits `refund.*`, `suspension.*`, `auth.*` ajoutés | `payment.checkout.error` garde l'acteur créateur |
| 17 | **Suites e2e legacy 17B** (`c3-premig`, `c4-premig`, `c4-release`, `c4-rollback`) | Q10a | **terminée** | **39/39 PASS** sur 3 bases dédiées refabriquées (`c3premig` = 58 migrations + DROP tables C1/C3/C4, `c4premig` = 58/58 sans C4, `c4test` complète partagée release/rollback) ; scénarios pré-migration intacts, garde `current_database()` ; **réintégrées en CI** (étapes dédiées) ; commit `3eb0852` | Bases **regénérées à chaque run CI** (aucun dump binaire committé) |
| 18 | **`next build`** (GO 10) | Q10b | **terminée** | `NODE_OPTIONS=--max-old-space-size=6144 npx next build` → **EXIT 0** (cause racine = OOM du heap V8 par défaut, pas de la RAM machine) ; étape CI dédiée ajoutée ; commit `3eb0852` | Routage/tsc = validation quotidienne ; `next build` en CI + avant release |
| 19 | **Parcours navigateur réels** : droits, achat par solde, recharge/validation, refus, renouvellement, remboursement (GO 10) | Q10d | **terminée** | `node recette\parcours-q10.mjs` = **22/22 PASS** (19 captures `recette/q10-*.png` + `q10-checks.json`) : droits client refusé `/manager`, boutique→panier→paiement→success, refus solde 0, justificatif déposé, validation admin (prompt `bankRef`), règlement par solde → « Commande payée », armer/révoquer renouvellement, refus plafond (« dépasse le total encaissé »), remboursement → « + avoir émis », après-coups portefeuille et factures `AV-` | Exécuté sur `next dev` (profil Edge dédié) ; scripts/preuves hors git |
| 20 | Déclenchement du pipeline CI GitHub (exécution réelle) | E1/Q10 | **non testée** | `.github/workflows/ci.yml` lint OK ; étapes **équivalentes exécutées en local** (typecheck×2, unit, e2e, legacy, next build) | Push interdit par le GO → le pipeline n'a jamais été exécuté sur GitHub |
| 21 | Adaptateur carte (webhook/signature) | C1 | **bloquée** | — | Décision **§6-1** (prestataire) non rendue |
| 22 | Recharge par carte + remboursement carte réel (`EXTERNAL_CARD` confirmé) | C3b | **bloquée** | — | Dépend C1 (§6-1) ; fondations internes (liens/plafonds/idempotence) = terminées en 11 |
| 23 | Suppression/anonymisation RGPD (M-07) + switch admin inscription gratuite (R-AUT-06) | — | **non testée** | — | Décisions owner (§6-7) ; la **demande** de clôture (tracée, sans exécution) = terminée en 2 |

**Ce que la table ne prétend PAS :** aucune ligne ne couvre un prestataire réel, une mise en production, un push ou une activation commerciale.

---

## 2. Résultats finaux (commandes · logs · bases · commit testé)

**Commit testé :** `3eb0852` (code) — docs de clôture = `20b2dc5`. Exécution consolidée Q11 via `recette/final-validation-q11.ps1`, logs `recette/logs/final-q11-*.log` :

| Étape | Commande (cwd) | Base | Résultat | Log |
|---|---|---|---|---|
| Typecheck API | `npx tsc --noEmit -p tsconfig.json` (`apps/api`) | — | **PASS** | `final-q11-tsc-api.log` |
| Build API | `npx nest build` (`apps/api`) | — | **PASS** | `final-q11-nest-build.log` |
| Unit complet | `npx jest src --maxWorkers=4` (`apps/api`) | — | **1203/1203 PASS — 65 suites** | `final-q11-unit.log` |
| e2e complet | `npx jest --config ./test/jest-e2e.json --runInBand --testPathIgnorePatterns c3-premig c4-premig c4-release c4-rollback` (`apps/api`) | `icode_host_pro_socle` | **488/488 PASS — 42 suites** | `final-q11-e2e.log` |
| e2e legacy (3) | idem avec `DATABASE_URL` = base dédiée + `--testPathPattern` | `icode_host_pro_c3premig` / `icode_host_pro_c4premig` / `icode_host_pro_c4test` | **39/39 PASS** | `final-q11-legacy-*.log` |
| Typecheck Web | `npx tsc --noEmit -p tsconfig.json` (`apps/web`) | — | **PASS** | `final-q11-tsc-web.log` |
| Build Web | `NODE_OPTIONS=--max-old-space-size=6144 npx next build` (`apps/web`) | — | **EXIT 0** (Q10b, étape CI) | console Q10b |
| Parcours navigateur | `node recette\parcours-q10.mjs` | `icode_host_pro_recette` | **22/22 PASS** | `recette/q10-checks.json` |
| Lint CI | `npx js-yaml .github/workflows/ci.yml` | — | PASS | — |

Logs de référence antérieurs : `recette/logs/e2e-final-p10*.log` (P10), console des lots Q-A→Q10 (détail : `TASKS.md`).

---

## 3. Preuves visuelles et parcours

- **11 captures** `recette/socle-p10-*.png` (listing admin, **panneau Actions administrateur**, **moyens de paiement**, taxe, facturation, factures, abonnements, recharges, portefeuille, mes factures, mes commandes).
- **19 captures** `recette/q10-*.png` + `recette/q10-checks.json` : parcours complet achat/réappro/renouvellement/remboursement (22 checks).
- Rejeu : `powershell -File recette\up-p10.ps1` puis `node recette\capture-socle-p10.mjs` / `node recette\parcours-q10.mjs` (voir `recette/GUIDE-RECETTE-P10.md`). Arrêt : `recette\down.ps1`.

---

## 4. Migrations, dépendances, fichiers (GO 11.5)

- **Migrations ajoutées : 10 additives** (aucune ancienne modifiée ; total **48 → 58**) : `20261002000000_add_payment_confirmation`, `20261002100000_add_password_reset`, `20261003000000_add_invoice_billing_terms`, `20261003000001_add_invoice_dunning`, `20261004045500_q_a_renewal_consent_invoice_subscription`, `20261004045643_q_a_index_invoice_subscription`, `20261004104124_q6_sweep_lease`, `20261004114140_q3_email_change_closure`, `20261005000001_q8_wallet_bankref_invoice_pdfstatus`, `20261005000002_q9_refunds_credit_notes`.
- **Dépendances ajoutées (2)** : `pdfkit` + `@types/pdfkit` (PDF facture) — `pnpm-lock.yaml` à jour.
- **Commits : 32** — liste exacte : `git log --oneline main..HEAD` (feature = `076a5ab`, `3fbbf62`, `2f3948c`, `8bd07d3`, `c498fda`, `ada8bed`, `73a6061`, `3eb0852` ; tests/docs = commits `test(*)`, `docs(*)` ; le reste = P0→P10).
- **Fichiers : 128 modifiés (+27 383 / −452)** — détails : `git diff --stat 3245694 5084864`. Nouveaux services notables : `RenewalService`, `InvoicePdfService`, `WalletService`, `RefundService`, `SuspensionEffectsService`, `sweep-guards` ; pages `/client/{commandes,factures,portefeuille}`, `/manager/{commandes,factures,facturation,taxe,recharges,moyens-paiement,subscriptions}`.
- **CI** : `.github/workflows/ci.yml` — typecheck×2, unit, e2e principal, **étape next build (heap 6144)**, **étapes bases dédiées + 3 suites legacy**.

---

## 5. Livrables de revue (GO 11.1–11.3, 11.6)

1. **Rapport (ce fichier)** : `docs/RAPPORT-SOCLE-COMMERCIAL.md`.
2. **HTML de suivi actualisé** : `docs/suivi-projet.html` (v8, ouverture locale + navigation vérifiées).
3. **Patch complet depuis `3245694`** : `recette/diff-socle-commercial.patch` — **couvre `3245694`→`5084864` (33 commits)** : 128 fichiers, +27 383/−452, 1 470 716 octets, nouveaux fichiers inclus, généré par `git diff 3245694 5084864 --binary --full-index --output=…` (écriture par Git lui-même = **aucune redirection d'encodage**).
4. **Vérification de fidélité (corruption d'export vs corruption source)** :
   - *Export* : deux exports successifs → **SHA-256 identiques** `71A13FD34B2D188B67C582856119F839CCB454631A58BFEBAED68CD93A259542` (export déterministe, non corrompu).
   - *Source* : `git apply --check --reverse` du patch contre l'arbre `5084864` → **exit 0** (le patch est exactement reproductible des blobs Git ; tout écart blob/arbre aurait fait échouer le reverse-apply).
5. **Guide court de recette manuelle** : `recette/GUIDE-RECETTE-P10.md` (mise à jour Q10/Q11).
6. **Commit/états** : `git status` propre ; `main`/`origin/main` = `3245694` intact.

---

## 6. Décisions réellement restantes (arbitrage owner — GO 11.7)

1. **§6-1 prestataire de paiement** → **C1 (adaptateur carte) et C3b (recharge + remboursement carte réels) restent bloqués**. Tout le reste du socle (fondations internes de remboursement, confirmation externe simulée étiquetée, paiement par solde, virement) est **terminé et testé** — la décision n'a pas été reclassée hors périmètre.
2. **§6-4 effet infrastructure exact de la suspension** → stop/start des apps via `PanelTransport` implémenté et testé en simulation (C4) ; **l'arrêt réel sur le panel live à activer en production** reste à trancher.
3. **§6-6 numérotation par exercice** → pas de remise à zéro annuelle aujourd'hui (`AAAA-seq` continu) ; trancher avant facturation en prod (réversible).
4. **§6-7 exécution RGPD** (suppression/anonymisation) **+ switch admin d'inscription gratuite** → non tranchés ; la demande de clôture avec tracé est terminée (exécution = décision).

*(Aucune autre décision ouverte : frais **appliqués** (Q-E), « payer par solde » **câblé** (Q-A), suites legacy **restaurées** (Q10a), `next build` **résolu** (Q10b).)*

---

## 7. Ce que ce rapport NE dit PAS

Aucune mise en production, aucun push/merge, aucun prestataire réel, aucun appel réseau sortant vers un panneau/DNS/paiement réel (simulations en recette), aucune activation commerciale. **ARRÊT ici pour revue globale unique** (GO item 11) : le statut = **branche locale prête pour revue**, à rejouer avec `recette/GUIDE-RECETTE-P10.md`.
