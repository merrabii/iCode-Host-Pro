# RAPPORT — GO socle commercial (P0→P10)

**Date :** 2026-10-04 · **Branche :** `feat/socle-commercial` (worktree `C:\Users\mourad.errabii\Documents\iCode-Host-Recette`)
**Base :** `icode_host_pro_socle` (docker `icode-postgres`) — 52 migrations · **Base recette UI :** `icode_host_pro_recette` (52 migrations depuis P10)
**Commits (10) :** `86c9f61` (A0) → `17f1bf2` (P2) → `792dab8` (P3) → `4b931e1` (P4) → `9d96a83` (P5) → `d5fdae1` (P6) → `62d68fb` (P7) → `d8b55e4` (P8) → `763ae38` (P9) → `d989dbe` (P10, clôture/docs) — **aucun push, aucun merge** (`main` = `3245694` intact).
**Diff complet :** `main...HEAD` = **93 fichiers, +15 848 / −355** (patch : `recette/diff-socle-commercial.patch`).
**Portée :** socle commercial de bout en bout (sécurité/paiement → comptes → visibilité → tarifs → factures → portefeuille → recharges → abonnements → exploitation/CI), cadres GO P0→P10 respectés.

---

## 1. Synthèse par capacité (statut · preuve · limite)

| Capacité (audit) | Lot | Statut | Preuve principale | Limite / réserve |
|---|---|---|---|---|
| RBAC administration (C-02) | A0 | **PASS** | e2e `rbac-deployment-modules` (USER → 403, 0 appel panneau) ; commit `86c9f61` | — |
| Récupération mdp oublié (E-06) | A1 | **PASS** | e2e `account-recovery` (16) ; commit `792dab8` | Suppression/anonymisation de compte (M-07/§6-7) = **non traité** (décision owner) |
| Édition profil | A1 | **PASS** | e2e recovery + pages `/profil` | — |
| Visibilité client/admin : mes commandes, mes factures, listings admin (E-03/E-07) | B1 | **PASS** | e2e `visibility-lists` (15) ; pages `/client/commandes`, `/client/factures`, `/manager/commandes`, `/manager/factures` ; captures P10 | Dashboard home : inchangé (KPI = pages listes) |
| Cohérence tarifaire : promo + arrondi + taux de taxe (E-01/M-02) | B2 | **PASS** | e2e `pricing-consistency` (prix affiché = prix débité, `taxAmountCents ≥ 0`) ; `/manager/taxe` (capture) ; commit `9d96a83` | Décision **§6-2a appliquée** : le prix promo est facturé |
| Fondations paiement : machine d'états `PENDING_PAYMENT→PAID`, confirmation serveur, rejeu/annulation (C-01/E-08) | C0 | **PASS** | e2e `store-payment-confirmation` (25) + `store-order-status` + `store-checkout-domains` ; commit `17f1bf2` | Webhook prestataire = hors périmètre (C1) |
| Confirmation avant livraison (virement) | C0/C3a | **PASS** | `confirm-payment` admin (UI P4) → provisioning seulement après confirmation ; e2e concernés verts | — |
| Portefeuille (solde, idempotence, concurrence) (C-03) | C2 | **PASS** | e2e `wallet-recharge` (12) ; page `/client/portefeuille` (capture) ; commit `d5fdae1` | « Payer une commande par solde au checkout » = **non câblé** (décision restante P6 documentée) |
| Recharge par virement (validation admin) (C-04) | C3a | **PASS** | e2e `wallet-recharge` (preuve refusée → 0 crédit ; validée → 1 crédit) ; `/manager/recharges` (capture) | — |
| Facturation : PDF figé, mentions, échéance, numérotation sûre, consultation (E-02) | D1 | **PASS** | e2e `invoice-billing` (11) : numéros uniques sous concurrence PG réelle, PDF octet-identique, mentions figées ; captures `client-factures` + `manager-facturation` ; commit `62d68fb` | Numérotation **sans remise à zéro annuelle** = décision **§6-6 restante** (tranchée côté code, réversible) |
| Avoirs / remboursements (facture) | — | **NON TRAITÉ** | — | Pas dans les lots GO (dépend C1/C3b) ; enums prêts |
| Abonnements : échéances, renouvellement par solde, dunning, suspension (E-04) | D2 | **PASS** | e2e `recurring-billing` (9) : 2e facture + débit unique, relance UNE fois, suspension CAS **statut seul**, reprise sans double débit ; commit `d8b55e4` | **§6-4 BLOQUÉ** : effet infrastructure de suspension non tranché (statut seul documenté) |
| Exploitation : UI des 5 actions admin (M-06) | E1 | **PASS** | capture `socle-p10-manager-commandes-detail-actions.png` (panneau « Actions administrateur » sur commande ACTIVE) ; e2e `audit-completeness` RBAC 401/403 | — |
| Exploitation : écran moyens de paiement (M-06) | E1 | **PASS** | capture `socle-p10-manager-moyens-paiement.png` (3 moyens, édition activé/ordre/frais/config) ; secrets `configEnc` jamais exposés | Frais **journalisés mais jamais appliqués** au calcul (R-FEE-05 = décision) |
| Audit complet (M-05) : acteur, transitions, frais | E1 | **PASS** | e2e `audit-completeness` (5/5) : acteur sur `payment.checkout`, acteur+from/to sur `payment.confirmed`, `order.transition` (confirm/claim/activation), frais en valeurs | `payment.checkout.error` garde l'acteur créateur (jamais inconnu) |
| CI unit + e2e (R-CI-07) | E1 | **PASS (locale)** | `.github/workflows/ci.yml` (1er du dépôt, `yaml-lint` OK) ; étapes équivalentes exécutées en local | **Pipeline GitHub non exécuté** (push interdit en chantier) |
| Adaptateur carte (webhook/signature) | C1 | **BLOQUÉ** | — | Décision **§6-1** (prestataire) non rendue |
| Recharge par carte + remboursements carte | C3b | **BLOQUÉ** | — | Dépend C1 |
| Suites e2e legacy 17B à base dédiée (c3-premig, c4-premig, c4-release, c4-rollback) | — | **NON TESTÉ** | — | Bases figées avant le GO (colonnes `Order.paidAt` etc. absentes) ; échec par design hors leur base ; **exclues du run complet et de la CI avec commentaire** ; réparation = refabrique des dumps dédiés |
| Switch admin inscription gratuite (R-AUT-06), RGPD (M-07) | — | **NON TRAITÉ** | — | Décisions owner restantes |

**Légende :** PASS = implémenté + testé ici · BLOQUÉ = GO requis (décision) · NON TESTÉ = connu, non rejoué · NON TRAITÉ = hors périmètre GO.

---

## 2. Tests (validation finale P10)

| Suite | Résultat | Log |
|---|---|---|
| **Unit complet** (`jest src --maxWorkers=4`) | **1077/1077 PASS — 60 suites** | console P10 |
| **e2e complet** (`jest --config test/jest-e2e.json --runInBand`, 4 suites legacy exclues) | **407/407 PASS — 38 suites** | `recette/logs/e2e-final-p10-run2.log` |
| e2e complet INCLUANT les 4 legacy (première passe) | 407/407 verts + **39 échecs attendus** des 4 suites legacy sur mauvaise base | `recette/logs/e2e-final-p10.log` |
| e2e `audit-completeness` (nouveau P9) | **5/5 PASS** | — |
| `tsc --noEmit` API | PASS | — |
| `tsc --noEmit` Web | PASS | — |
| `yaml-lint` CI | PASS | — |
| Smoke e2e (63), suites ciblées P9 (128 unit), non-régression (80) | PASS (déjà acquis, repris dans les totaux ci-dessus) | — |
| `next build` | **ÉCHEC outil** (worker exit 134 / OOM — machine) ; `nest build` OK ; web validé par `tsc` ; UI servie en `next dev` pour preuves | limitation machine, non bloquante |
| Lint ESLint | absent du workspace (préexistant, non bloquant) | — |

---

## 3. Preuves visuelles (recette locale, stack P10 : API 3011 + web 3002 `next dev`)

11 captures dans `recette/socle-p10-*.png` (script : `recette/capture-socle-p10.mjs`) :

| Capture | Ce qu'elle prouve |
|---|---|
| `manager-commandes-liste` | Listing admin paginé + filtres (P4) |
| **`manager-commandes-detail-actions`** | Détail + **panneau « Actions administrateur »** (Terminer / Ré-synchroniser) — P9b |
| **`manager-moyens-paiement`** | Écran complet moyens de paiement (actifs/ordre/frais/config) — P9c |
| `manager-taxe` | Taux de taxe admin (P5) |
| `manager-facturation` | Paramètres facturation + mentions (P7) |
| `manager-factures` | Factures admin (P4/P7) |
| `manager-subscriptions` | Abonnements : statut + Suspendre/Ré-synchroniser (P8) |
| `manager-recharges` | Validation recharges admin (P6) |
| `client-portefeuille` | Portefeuille client (P6) |
| `client-factures` | Mes factures + Détail/PDF (P4/P7) |
| `client-commandes` | Mes commandes + statuts (P4) |

Rejeu : `powershell -File recette\up-p10.ps1` puis `node recette\capture-socle-p10.mjs` (voir `recette/GUIDE-RECETTE-P10.md`). Arrêt : `recette\down.ps1`.

---

## 4. Migrations, dépendances, fichiers

- **4 migrations additives** (aucune ancienne modifiée ; total **52**) : `20261002000000_add_payment_confirmation` (49e), `20261002100000_add_password_reset` (50e), `20261003000000_add_invoice_billing_terms` (51e), `20261003000001_add_invoice_dunning` (52e).
- **Dépendances ajoutées (2)** : `pdfkit` + `@types/pdfkit` (P7, justifié PDF facture) — lockfile à jour.
- **Nouveaux services/pages notables** : `RenewalService` (D2), `InvoicePdfService` (D1), `WalletService` (C2), pages `/client/{commandes,factures,portefeuille}`, `/manager/{commandes,factures,facturation,taxe,recharges,moyens-paiement,subscriptions}`.
- **CI** : `.github/workflows/ci.yml` (postinstall `@prisma/engines`, service `postgres:16`, typecheck×2, unit, e2e avec exclusion commentée des 4 suites legacy).

---

## 5. Décisions restantes (arbitrage owner — aucune tranchée seul)

1. **§6-1 prestataire de paiement** → C1/C3b **BLOQUÉS**.
2. **§6-4 effet infra de la suspension** → implémenté = statut seul (P8) ; un vrai arrêt d'apps reste à trancher.
3. **§6-6 numérotation par exercice** → pas de remise à zéro annuelle (séquence continue `AAAA-seq`) ; réversible.
4. **§6-7 suppression/anonymisation RGPD + switch inscription gratuite** → non traités.
5. **« Payer par solde au checkout »** → non câblé (P6) ; le renouvellement D2 passe bien par le solde.
6. **Frais de paiement (R-FEE-05)** → journalisés (P9) mais non appliqués au calcul : appliquer ou masquer.

---

## 6. Ce que ce rapport NE dit PAS

Aucune mise en production, aucun push/merge, aucun prestataire réel, aucun appel réseau sortant (panneaux/DNS/paiement simulés ou stubés en recette), aucune activation commerciale. Le statut = **branche locale prête pour revue**.
