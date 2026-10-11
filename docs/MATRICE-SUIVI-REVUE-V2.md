# Matrice de suivi — GO CORRECTIONS DES ÉCARTS CONFIRMÉS PAR LA REVUE (V2)

> Texte du GO : `docs/GO-CORRECTIONS-REVUE-PAIEMENTS-V2.md` (worktree principal,
> chemin absolu `C:\Users\mourad.errabii\Documents\Projet iCode Host\docs\GO-CORRECTIONS-REVUE-PAIEMENTS-V2.md`).
> Légende : **[C]** code présent (existant, non re-implémenté) · **[+]** correction apportée ·
> **[T]** test/exercice effectué · **[P]** preuve citée · **[R]** reste à faire · **[B]** bloqué.
> Aucun [V] sans test exact + résultat daté (règle GO §7a).

Dernière mise à jour : 11/10/2026 00:55 (session GO2 — toutes les preuves exercées).

## §1 — Comptabilisation des remboursements distincts

| Sous-point | Code présent | Vérification | Preuve | Reste à faire |
|---|---|---|---|---|
| 1a — deux refund.updated SUCCEEDED distincts 300+400 avant charge.refunded → 700 (pas 400) | `[C]` refund-accounting.ts existe (union des identités) | `[T]` §2.9 e2e | refund-accounting 12/12 (11/10) | — |
| 1b — externe 300 observé + interne distinct 400 → 700 (pas 400) | `[C]` idem | `[T]` §2.10 e2e | refund-accounting 12/12 (11/10) | — |
| Identités durables vs observations cumulatives | `[C]` RefundObservation (union) | `[T]` §2.7/§2.9/§2.12 | refund-accounting 12/12 (11/10) | — |
| Montant individuel refund.* jamais traité comme cumul de charge | `[C]` applyChargeRefunded = plancher, recordRefundObservation = identité | `[T]` §2.13 course croisée 300 JAMAIS 600 | refund-accounting §2.13 (11/10) | — |
| Incertitude conservée si calcul impossible + rapprochement avant opération plafond | `[C]` §2.11 | `[T]` e2e | refund-accounting 12/12 (11/10) | — |
| Tests : doublons, ordres inversés, partiels int/ext, avant référence locale, concurrence, réservations | `[C]` 12 tests (union) | `[T]` 12/12 | refund-accounting.e2e (11/10) | — |
| Aucun mouvement wallet pour remboursement commande carte directe | `[C]` C2.10 | `[T]` parcours-cloture remboursement-conclu-montants (solde inchangé) | parcours-cloture 33/33 (11/10) | — |

## §2 — Identité et rotation de configuration

| Sous-point | Code présent | Vérification | Preuve | Reste à faire |
|---|---|---|---|---|
| 2a1 — `currentIdentity()`/`resolveFor()` : supprimer `verified ?? declared` | `[C]` vérifié seul | `[T]` unit payment-provider.spec | 180/180 unit (11/10) | — |
| 2a2 — `checkConnection()` : capturer version config AVANT réseau, CAS sur cette version | `[C]` snapshot avant réseau + CAS id+version (l.249-255) | `[T]` unit + rotation test | payment-provider.spec (11/10) | — |
| 2a3 — Test rotation clé A→B pendant appel : preuve A ne valide jamais B | `[C]` test « édition PENDANT l'appel → preuve REFUSÉE » | `[T]` unit | payment-provider.spec l.256 (11/10) | — |
| 2b1 — Webhooks remboursement/litige/transitions : vérifier fournisseur+compte+environnement contre identité d'origine | `[C]` originRefusal (fournisseur+merchant+environment) | `[T]` unit payment-webhook.spec | 180/180 (11/10) | — |
| 2b2 — Conserver identité authentifiée à la réception (rapprochements ultérieurs) | `[C]` currentIdentity() à réception | `[T]` unit | payment-webhook.spec (11/10) | — |

## §3 — Dispatch, reprises et webhooks durables

| Sous-point | Code présent | Vérification | Preuve | Reste à faire |
|---|---|---|---|---|
| 3a — `dispatchCheckout()` : `updateMany dispatchedAt` non excluant → acquisition conditionnelle (CAS) | `[C]` CAS NOT_RESOLVED→DISPATCHED, claimed.count vérifié (l.603) | `[T]` unit + e2e | 180/180 + suites e2e (11/10) | — |
| 3b — `enterDispatch()` remboursements : borner la reprise | `[C]` fenêtre 24h (IDEMPOTENCE_RETENTION_MS, card-refunds.service.ts:66) | `[T]` e2e §4 reprise déterministe | refund-accounting §4 (11/10) | — |
| 3c — Échec tardif n'écrase pas une réussite persistée | `[C]` écriture CAS bornée NOT_RESOLVED | `[T]` unit | 180/180 (11/10) | — |
| 3d — Premier `dispatchedAt` immuable | `[C]` C4.1 | `[T]` e2e §4 (firstDispatchedAt immuable) | refund-accounting §4 (11/10) | — |
| 3e — Reprise remboursements bornée (24h) | `[C]` fenêtre 24h | `[T]` e2e | refund-accounting (11/10) | — |
| 3f — Classification erreurs : pas de « tout 4xx = échec certain » | `[C]` isUncertainDispatchError (408/429/5xx) | `[T]` unit | 180/180 (11/10) | — |
| 3g — Sweep : couvrir crash après insertion RECEIVED avant `reconcileAt` | `[C]` sweep inclut `reconcileAt IS NULL` + 60 s de grâce (l.412-414) | `[T]` e2e §3a orphelin rejoué | payment-webhook e2e (11/10) | — |
| 3h — Rapprochement épuisé sans paiement rattaché consultable admin | `[C]` C4.7 | `[T]` e2e | refund-accounting (11/10) | — |
| 3i — Tests barrières contrôlées + compteurs d'appels + réponses intercalées | `[C]` chain-revocation-barrier + order-card-payment C3 VRAIE course (Promise.all) | `[T]` 20/20 | order-card-payment.e2e (11/10) | — |

## §4 — Garde solde et désactivation des moyens

| Sous-point | Code présent | Vérification | Preuve | Reste à faire |
|---|---|---|---|---|
| 4a — `payOrderWithWallet()` bloquer NEEDS_REVIEW + interventionNeeded (tous parcours) | `[C]` assertNoBlockingCardPayment (blocking-payment.guard.ts) | `[T]` unit pay-order-wallet + checkout | 180/180 (11/10) | — |
| 4b — `refreshFromProvider()` : première émission → `assertCardMethodActive()` | `[C]` card-payments.service.ts:942-947 | `[T]` unit card-payments.spec | 180/180 (11/10) | — |
| 4c — Désactivation concurrente vérifiée ; constat/remboursement ops émises conservés | `[C]` C5.3/C5.4 + parcours-cloture désactivation en vol → 409 PAYMENT_METHOD_DISABLED | `[T]` parcours-cloture | 33/33 (11/10) | — |

## §5 — Parcours client et admin

| Sous-point | Code présent | Vérification | Preuve | Reste à faire |
|---|---|---|---|---|
| 5a — Vrai choix Solde/Carte au checkout selon capacités, sans recharge imposée, sans mixte | `[C]` page checkout (radio « Solde du portefeuille » visible si caps actives) | `[T]` parcours-cloture moyen-carte-present + p6b j1-moyen-solde-present | 33/33 + 26/26 (11/10) | — |
| 5b — Capacités = opérationnel + actif + devise ; `cardProviderStatus()` aligné sur connecteur résolu | `[C]` stripe-usability.ts (règles uniques) + cardProviderStatus() | `[T]` unit + e2e | 180/180 + suites (11/10) | — |
| 5c — Bouton admin remboursement distingue ORDER/TOPUP ; ORDER → parcours commande (pas wallet) ; testé jusqu'à SUCCEEDED via bouton | `[C]` paiements-carte/page.tsx:219-252,752 (ORDER → createAdminRefund EXTERNAL_CARD ; TOPUP → createCardRefund) | `[T]` parcours-cloture (ORDER : « Rembourser la commande vers la carte » → SUCCEEDED) + p6b J4 (TOPUP : « Rembourser vers la carte » → SUCCEEDED + débit) | 33/33 + 26/26 (11/10) | — |
| 5d — TopupAttempt client+parcours+montant+devise ; tests comportementaux navigateur | `[C]` api.ts:2923-3023 | `[T]` p5d-topup-attempt.mjs 18/18 (S1 changement compte, S2 ancien format, S3 réouverture onglet, S4 perte réseau, S5 stockage indisponible, S6 rechargement mémoire perdue) + card-topup e2e B9 (nouvelle clé refusée 409 sur tentative non résolue) | harnais Node (11/10) + card-topup 49/49 (11/10) | — |

## §6 — Preuves et outillage

| Sous-point | Code présent | Vérification | Preuve | Reste à faire |
|---|---|---|---|---|
| 6a1 — VRAIE course solde ∥ carte (Promise.all, PG réelle, verrou FOR UPDATE) | `[+]` order-card-payment C3 ajouté | `[T]` 20/20 (exactly one 201, loser 409, invariants wallet/order) | order-card-payment.e2e (11/10) | — |
| 6a2 — Course charge.refunded ∥ refund.updated (MÊME remboursement externe) | `[+]` refund-accounting §2.13 ajouté | `[T]` 12/12 (300 JAMAIS 600) | refund-accounting.e2e (11/10) | — |
| 6b — Navigateur : paiement solde + carte directe + recharge + remboursement admin (ORDER+TOPUP) via UI | `[+]` p6b-parcours-paiements.mjs (J1 solde, J3 recharge, J4 TOPUP) + parcours-cloture.mjs étendu (J2 carte directe, J4 ORDER) | `[T]` p6b 26/26 + parcours-cloture 33/33 | p6b-checks.json + cloture-checks.json + captures p6b-*.png / cloture-*.png (11/10) | — |
| 6c — Isolation : API = même base que Prisma avant mutations | `[+]` p6c-isolation-api-prisma + p6c-isolation-topup intégrés à p6b | `[T]` 26/26 (users/me relu par Prisma ; référence API = ligne Prisma) | p6b-checks.json (11/10) | — |
| 6d — down.ps1 : identité lancement + worktree, refus entrée inconnue + PID réutilisé | `[+]` main worktree down.ps1 URI-décodé + marqueurs worktree-absolus | `[T]` Test A clé inconnue → REFUS + rien tué ; Test B PID étranger → REFUS + vivant ; bon chemin → identifié + tué (EXIT=0) | journal session (11/10) | — |

## §7 — Clôture documentaire et livraison

| Sous-point | Code présent | Vérification | Preuve | Reste à faire |
|---|---|---|---|---|
| 7a — Critères actualisés, aucun [V] non exercé | `[+]` GO-CLOTURE-CRITERES.md actualisé | `[T]` relecture | en cours | — |
| 7b — Rectifs docs (marque Code Diali / Code Diali LLC, Stripe test ≠ PaymentCloud live, simulation≠test≠live, pas de déploiement b01951b seul, retour arrière + rapprochement post-sauvegarde) | `[R]` | `[R]` | — | Rectifier rapport/HTML/STATUT/checklist |
| 7c — Validation ciblée puis consolidation finale, preuves desktop/mobile séparées | `[R]` | `[R]` | — | À la fin |
| 7d — V2 = partielle (preuve de reprise) ; V3 sur Bureau = livraison finale | `[C]` V2 zip 43 821 o (SHA ED6555…) | `[R]` produire V3 | — | Archive V3 sur Bureau Windows |

## Points déjà acquis (conservés, non re-implémentés)

- C2.10 (aucun wallet pour remboursement commande carte) — order-card-payment 20/20.
- C3.4 (CAS checkConnection id+secretKeyHash) — conservé, complété par 2a2.
- C4.1 (`dispatchedAt` immuable) / C4.3 (classification 408/429/5xx) — conservés.
- C4.7 (rapprochement épuisé consultable) — conservé.
- C5.3/C5.4 (désactivation bloque émission, ops émises continuent) — conservés.
- C5.7 (`cardProviderStatus()`, e2e stripe-no-simulator 6/6) — conservé, aligné par 5b.
