# Rapport des sept points — Corrections des écarts confirmés par la revue

**Date :** 11/10/2026 · **Branche :** `feat/stripe-test` · **HEAD :** `b01951bd05c4cf54eb9c7c172adb734cbc70b5c5` (intact, aucun commit)
**GO :** `docs/GO-CORRECTIONS-REVUE-PAIEMENTS-V2.md` · **Matrice :** `docs/MATRICE-SUIVI-REVUE-V2.md`
**Règle appliquée** : aucun point clos par un commentaire ou une compilation ; chaque statut [V] = test exact exécuté + résultat daté.

> **Note d'intégrité** : les corrections des points 1–4 et du §5d (code) étaient **déjà présentes dans le lot non committé** avant cette session (état examiné lors de la revue). La session GO2 a **inspecté** ce code existant puis l'a **exercé** par des tests dédiés (repros, courses réelles, parcours navigateur) ; seule l'écriture des tests/parcours est neuve, sauf mentions contraires ci-dessous.

---

## 1. Comptabilisation des remboursements distincts

| Élément | Détail |
|---|---|
| **Défaut** | `max(courant, somme interne, montant observé)` ne calcule pas l'**union** des remboursements distincts : (a) deux `refund.updated` externes SUCCEEDED distincts 300 puis 400 avant `charge.refunded` → 400 au lieu de 700 ; (b) externe 300 observé + interne distinct 400 → 400 au lieu de 700. Le montant individuel de `refund.*` pouvait être traité comme un cumul de charge. |
| **Correction (lot, inspectée)** | `apps/api/src/payments/refund-accounting.ts` : **identités durables** des remboursements (par identifiant fournisseur, `RefundObservation`) distinctes des **observations cumulatives** de charge ; cumul = union par identité (jamais la somme brute des observations) ; `applyChargeRefunded` = **plancher** (floor) monotone, jamais un cumul ; `interventionNeeded` conservé quand l'observation ne permet pas un calcul exact (rapprochement avant toute opération dépendant du plafond) ; `FOR UPDATE` + `syncRefundedCents` monotone pour la concurrence. |
| **Fichiers** | `apps/api/src/payments/refund-accounting.ts` · `apps/api/src/payments/card-refunds.service.ts` (fenêtre 24 h, reprise bornée) · modèle `RefundObservation` (migration du lot) |
| **Preuve (11/10)** | `apps/api/test/refund-accounting.e2e-spec.ts` **12/12 PASS** : t.1-3 doublons/ordres inversés/rejeux ; **§2.9** = repro (a) deux refund.updated externes distincts 300+400 → **700** ; **§2.10** = repro (b) externe 300 + interne 400 → **700** ; §2.11 inconnu succeeded → plafond + intervention ; §2.12 arrivée avant référence locale ; **§2.13 course croisée** `charge.refunded ∥ refund.updated` (Promise.all, **même** remboursement externe `re_cross_*`) → **300 JAMAIS 600**, statut `PARTIALLY_REFUNDED`, `interventionNeeded=true` (correct : remboursement externe = signal hors plateforme), solde inchangé. Aucun mouvement wallet pour remboursement de commande carte : parcours navigateur `remboursement-conclu-montants` (solde inchangé=true, 11/10). |
| **Limites** | Les repros (a)/(b) portent sur la version corrigée du lot (le défaut historique n'était pas committé : pas de base « avant » reconstituable pour un test rouge vert). Les 12 tests prouvent le comportement attendu sur l'arbre exact examiné. |

## 2. Identité et rotation de configuration

| Élément | Détail |
|---|---|
| **Défaut** | (a) `currentIdentity()`/`resolveFor()` acceptaient `verified ?? declared` (le compte déclaré non vérifié suffisait) ; `checkConnection()` capturait `updatedAt` **après** `verifyAccount()` (preuve pouvant valider une config changée pendant l'appel). (b) Webhooks remboursement/litige/transitions ne filtraient que `providerCode`/`providerRef`. |
| **Correction (lot, inspectée)** | Identité = **vérifiée seule** (`lastCheckAccount`) ; `checkConnection` capture la version config **AVANT** le réseau puis conditionne l'écriture de la preuve par CAS `id+secretKeyHash+version` ; rotation clé A→B pendant l'appel → preuve A **refusée** sur B (test unit dédié). Webhooks : vérification **fournisseur + compte marchand + environnement** contre l'identité d'origine (`originRefusal`), identité authentifiée **conservée à la réception** pour les rapprochements ultérieurs (jamais remplacée par la config courante). |
| **Fichiers** | `apps/api/src/payments/payment-provider.service.ts` (l.249-255 snapshot avant réseau + CAS) · `apps/api/src/payments/payment-webhook.service.ts` |
| **Preuve (11/10)** | Unit `payment-provider.spec` + `payment-webhook.spec` inclus dans **180/180 PASS** (7 suites) ; rotation « édition PENDANT l'appel → preuve REFUSÉE » ; e2e A5 (card-topup) : provider declared sans verified → **409**. |
| **Limites** | Test de rotation réelle sur instance distante non possible sans second compte fournisseur ; le test unitaire contrôle l'ordre capture/CAS, qui est le mécanisme déterminant. |

## 3. Dispatch, reprises et webhooks durables

| Élément | Détail |
|---|---|
| **Défaut** | `dispatchCheckout()` : `updateMany dispatchedAt` **non excluant** (résultat ignoré, tous les appelants pouvaient émettre) ; `enterDispatch()` remboursements repart sans référence ; échec tardif pouvait écraser une réussite persistée ; sweep limité à `RECEIVED` **avec** `reconcileAt <= now` (crash entre insertion et `reconcileAt` non couvert). |
| **Correction (lot, inspectée)** | Acquisition conditionnelle **CAS** (`NOT_RESOLVED → DISPATCHED`, `claimed.count` vérifié) ; écritures tardives bornées CAS (un échec tardif n'écrase jamais une réussite persistée) ; premier `dispatchedAt` immuable ; reprise remboursements bornée à **24 h** (`IDEMPOTENCE_RETENTION_MS`) sans réémission après expiration ; classification des erreurs (`isUncertainDispatchError` : 408/429/5xx/timeout = incertain, autres 4xx = refus certain) ; sweep étendu à `reconcileAt IS NULL` avec âge ≥ 60 s de grâce ; rapprochement épuisé → `FAILED` + `interventionNeeded` consultable admin. |
| **Fichiers** | `apps/api/src/payments/card-payments.service.ts` (l.603 CAS dispatch, l.412-414 sweep) · `apps/api/src/payments/card-refunds.service.ts` (l.66 fenêtre 24 h) · `apps/api/src/store/reconcile.runner.service.ts` |
| **Preuve (11/10)** | `refund-accounting.e2e` §3 (orphelin `reconcileAt NULL` rejoué) et §4 (reprise bornée, `firstDispatchedAt` immuable) dans le **12/12** ; `order-card-payment.e2e` **20/20** (C3 : une seule émission, loser 409) ; unit **180/180**. |
| **Limites** | Aucun. |

## 4. Garde solde et désactivation des moyens

| Élément | Détail |
|---|---|
| **Défaut** | `payOrderWithWallet()` ne bloquait que les cartes `CREATED/PROCESSING` (pas `NEEDS_REVIEW` ni issue non résolue) ; `refreshFromProvider()` vérifiait l'interrupteur mais pas `assertCardMethodActive()` à la première émission ; désactivation concurrente non vérifiée de bout en bout. |
| **Correction (lot, inspectée)** | `assertNoBlockingCardPayment` (blocking-payment.guard.ts) bloquant **toute** issue carte non résolue (dont `NEEDS_REVIEW`/`interventionNeeded`) avant tout débit solde ; `assertCardMethodActive()` appliqué à **toutes** les premières émissions (card-payments.service.ts:942-947) ; désactivation = refus immédiat côté serveur (`PAYMENT_METHOD_DISABLED` 409) **y compris** sur endpoint de rafraîchissement ; opérations déjà émises continuent (webhooks, rapprochement, remboursement sans gate). |
| **Fichiers** | `apps/api/src/payments/blocking-payment.guard.ts` · `apps/api/src/payments/card-payments.service.ts` · `apps/api/src/payments/stripe-usability.ts` |
| **Preuve (11/10)** | Unit **180/180** (pay-order-wallet, checkout, card-payments) ; parcours navigateur `parcours-cloture.mjs` **33/33** : désactivation en vol → `cardOrderPaymentEnabled=false` + **409 `PAYMENT_METHOD_DISABLED`** + bouton carte **absent** du success (`success-sans-bouton-carte`), puis réactivation. |
| **Limites** | Aucun. |

## 5. Parcours client et admin réellement utilisables

### 5a — Choix au checkout
- **Défaut** : pas de vrai choix Solde/Carte exerçable ; risque de recharge imposée.
- **État** : le solde est un **règlement post-création** (`payOrderWithWallet`) ; le choix s'offre au checkout (moyen carte) **et** au retour success/commandes/factures (solde), tous caps-gated, serveur re-gaté (`assertEnabled`).
- **Preuve (11/10)** : p6b `j1-moyen-solde-present` (radio « Solde du portefeuille ») + `j1-payWithWallet-201` (**201** via radio solde, commande PAYÉE) — p6b **26/26** ; `parcours-cloture` `moyen-carte-present` (radio « Carte bancaire ») — **33/33**. Aucune recharge imposée ; **aucun paiement mixte** (aucun code de débit partiel).

### 5b — Capacités = opérationnel + actif + devise
- **Défaut** : capacités fondées sur les seuls interrupteurs ; `cardProviderStatus()` non aligné sur le connecteur résolu.
- **État** : `stripe-usability.ts` = règles uniques (interrupteur + moyen actif + devise concordante + connecteur vérifié disponible) ; `cardProviderStatus()` aligné sur le **connecteur réellement résolu** (`lastCheckAccount` exigé) ; chargement/erreur caps → **fail-closed** (4 pages web corrigées le 09/10, C5.5).
- **Preuve (11/10)** : unit **180/180** ; e2e `stripe-no-simulator` 6/6 (09/10, rejoué dans la batterie) ; parcours : capacité serveur lue (`cardOrderPaymentEnabled=false` → bouton absent).

### 5c — Bouton admin remboursement distingue ORDER/TOPUP
- **Défaut** : le bouton « Rembourser vers la carte » contournait par un POST direct ; défaut signalé.
- **État (lot, inspectée)** : `apps/web/src/app/manager/paiements-carte/page.tsx:219-252,752` — ORDER → `createAdminRefund` **EXTERNAL_CARD** (parcours de remboursement de commande vers sa carte, **jamais** wallet) ; TOPUP → `createCardRefund` (débit wallet) ; libellés distincts.
- **Preuve (11/10)** : **ORDER** : parcours-cloture — recherche admin → détail (mention « règlement de commande ») → bouton « Rembourser … vers la carte » **clicqué** → refund **SUCCEEDED/500 cts**, `PARTIALLY_REFUNDED`, `order.statut=PROVISIONING` inchangé, **solde inchangé**, ligne visible UI « Remboursé · 5.00 USD · Rembursement conclu (bouton parcours clôture) » ; **TOPUP** : p6b J4 — détail (mention « recharge de portefeuille ») → bouton « Rembourser vers la carte » **clicqué** → refund SUCCEEDED/500, **solde débité 6000→5500**. Refus wallet sur ORDER : `kind=WALLET_CREDIT` → **409 REFUND_ORIGIN_CARD**. Total : p6b **26/26** + parcours-cloture **33/33**.

### 5d — Intention navigateur TopupAttempt
- **Défaut** : « implémenté » annoncé = compilation seule ; la mémoire perdue (rechargement) n'était pas exercée ; protection serveur non prouvée.
- **État (code du lot, conservé)** : `apps/web/src/lib/api.ts:2923-3023` — `TopupAttempt = {amountCents, currency, userId, flow:'topup', key, reference?}` lié **client + parcours + montant + devise** ; appel dans `client/portefeuille/page.tsx` (~l.209).
- **Preuve (11/10)** :
  - **Côté client** : `recette/p5d-topup-attempt.mjs` — harnais Node transpilant le **vrai** `api.ts` (typescript réel, `window.sessionStorage` contrôlé) : **18/18** — S1 changement de compte (ancien compte → ancienne clé refusée), S2 ancien format/corruption (fallback clé éphémère), S3 fermeture/réouverture onglet (reprise même clé → **même session**), S4 perte réseau + clear ciblé (rejeu → même session, zéro 2ᵉ tentative), S5 stockage indisponible (fallback documenté), S6 **rechargement → MÉMOIRE PERDUE → NOUVELLE clé générée**.
  - **Côté serveur (protection complémentaire exigée)** : `card-topup.e2e-spec.ts` **§B9** — tentative non résolue + nouvelle clé → **409**, `idempotencyKey` count = **0** (zéro 2ᵉ tentative) ; rejeu même clé → **MÊME session RESOLVED** ; après résolution, clé B acceptée. Suite **49/49 PASS**.
- **Limites** : harnais client = sessionStorage contrôlé (pas un navigateur physique) ; le parcours navigateur réel (p6b) exerce le même `api.ts` compilé dans le build web, ce qui confirme le comportement en conditions réelles.

## 6. Preuves et outillage

### 6a — Concurrence : vraies courses
- **Défaut** : C1/C2 order-card-payment = séquentiel (beforeAll) présenté à tort comme course ; refund-accounting lançait deux `charge.refunded` identiques (pas la course demandée).
- **Ajouts (session GO2, neufs)** :
  - `order-card-payment.e2e-spec.ts` **C3 « VRAIE course solde ∥ carte »** : `Promise.all([walletPay, openCardPayment])` sur la **même commande**, wallet fondé +100 000 → **exactement un 201**, loser **409**, invariants : (PAID + carte SUCCEEDED + wallet débité) OU (PENDING_PAYMENT + solde inchangé). **20/20 PASS** (suite entière, 11/10).
  - `refund-accounting.e2e-spec.ts` **§2.13 course croisée** : `Promise.all([charge.refunded, refund.updated])` sur le **même** remboursement externe → **300 JAMAIS 600**. **12/12 PASS** (11/10).
- **Limites** : courses sous PostgreSQL réel du conteneur `icode-postgres` (base `icode_host_pro_socle`), barrière `FOR UPDATE` — pas de multi-machine (hors périmètre).

### 6b — Navigateur : les 4 parcours + remboursement admin via UI
- **Défaut** : afficher le portefeuille ≠ payer par solde ; recharge et remboursement non exercés via l'UI.
- **Preuve (11/10)** :
  - **p6b-parcours-paiements.mjs : 26/26** — J1 paiement **solde** (radio + `payWithWallet` → 201, PAYÉE, wallet débité) ; J3 **recharge carte** (formulaire, page hébergée simulée, crédit `SUCCEEDED/TOPUP` +5000, solde UI « 60,00 » = DB 6000 cts) ; J4 **remboursement recharge** via bouton admin (débit 500) ; P6c isolation intégrée.
  - **parcours-cloture.mjs : 33/33** — J2 **carte directe** (page hébergée `cs_sim_*`, PAYÉE, `card=SUCCEEDED/ORDER`, **solde 0→0, walletTx=aucune**) ; J4 **remboursement ORDER** via bouton (SUCCEEDED 500, wallet inchangé) ; refus wallet 409 ; désactivation en vol ; double-paiement 409 ; anonyme 401.
  - Captures : `recette/p6b-01..07-*.png` + `recette/cloture-01..09-*.png` ; checks JSON : `recette/p6b-checks.json`, `cloture-checks.json`.

### 6c — Isolation API = base Prisma
- **Preuve (11/10)** : intégré à p6b (`p6c-isolation-*`) : marqueur écrit **via API** relu **par Prisma** ; référence topup API = ligne Prisma (`p6c-isolation-topup`). DB cible vérifiée par `db-guard.mjs` (`current_database()` = `icode_host_pro_recette`) **avant** toute mutation ; e2e = `DATABASE_URL` explicite `icode_host_pro_socle` posée avant le bloc.

### 6d — down.ps1 : identité + worktree + refus
- **Défaut** : marqueur générique `dist/src/main.js` / `dist/bin/next` = appartenance non prouvée ; worktree non vérifié ; entrée inconnue non refusée.
- **Correctif (session GO2)** : `recette/down.ps1` du worktree principal — comparaison marqueurs sur chemin **absolu du worktree courant** (+ décodage `%20` des URI Edge pour les worktrees avec espaces) ; entrée inconnue de `pids.json` = **REFUS** sans tuer.
- **Preuve (11/10)** : **Test A** `{ "evil": 99999 }` → `REFUS cle inconnue 'evil'`, **exit 1**, `pids.json` conservé, rien tué ; **Test B** PID d'un processus étranger (`node -e` vivant) listé comme `api` → `REFUS … marqueur(s) manquant(s)` (PID réutilisé ? worktree étranger ?), **exit 1**, processus **vivant** ; **bon chemin** → chaque PID identifié (guard path + binaire du worktree courant) puis tué, **exit 0**, `pids.json` retiré.

## 7. Clôture documentaire et livraison

| Sous-point | État | Preuve |
|---|---|---|
| 7a — critères actualisés, aucun [V] non exercé | `[V]` | `docs/GO-CLOTURE-CRITERES.md` §11 (11/10) : chaque ligne = test exact de ce rapport ; aucune ligne reprise sans exercice. |
| 7b — rectifs docs | `[V]` | Marque **Code Diali** (publique) / **Code Diali LLC** (entité) ; Stripe **déjà choisi** (test), PaymentCloud **ultérieur** (option) ; simulation ≠ Stripe test ≠ live ; **b01951b seul non déployable** (corrections non committées) ; retour arrière complété du **rapprochement post-restauration** (paiements intervenus après sauvegarde). Rectifié dans : CHECKLIST-PRODUCTION (§1, §7, rappels), DOSSIER-CLOTURE, GUIDE-STRIPE-TEST, présent rapport, ETAT-REPRISE, suivi HTML/STATUT. |
| 7c — validation ciblée puis consolidation | `[V]` | Ciblée : suites affectées du GO2 (12/12, 20/20, 49/49) + harnais 18/18 + parcours 26/26 et 33/33 (11/10). Consolidation finale sur le code exact : `recette/logs/final-go2-*.log` (11/10) — prisma validate, tsc API/web, nest build, unit ciblés, e2e ciblés, git diff --check, état git. |
| 7d — V2 = partielle ; V3 = livraison | `[V]` | V2 conservé (preuve de reprise, 43 821 o, SHA `ED655508…`). **V3** : `C:\Users\mourad.errabii\Desktop\REVUE-CLOTURE-PAIEMENTS-V3.zip` — **3 774 569 o**, SHA-256 **`3D861C017332FBB40465C3B2DCF851EE12F2D6DAD796122EC1D3FF87520111F7`** (56 entrées). **Signal d'intégrité** : l'arbre « examiné lors de la revue » (10/10, non committé) **n'est pas reconstituable avec certitude** (jamais committé, aucun snapshot horodaté complet ; le V2 zip ne contenait que le diff §5d). Aucune base inventée : le **patch complet b01951b→arbre** (`14D0B35B…`, reverse-apply exit 0) contient l'intégralité du lot + corrections ; le patch global `78b51ce→arbre` (`F9BB0148…`) complète la base poussée. |

---

## Synthèse des résultats (11/10/2026)

| Suite / parcours | Résultat |
|---|---|
| Unit paiements (7 suites) | **180/180** |
| `refund-accounting.e2e` (§2.9/§2.10/§2.13 neufs) | **12/12** |
| `order-card-payment.e2e` (C3 neuf) | **20/20** |
| `card-topup.e2e` (§B9 neuf) | **49/49** |
| Harnais client TopupAttempt (p5d) | **18/18** |
| Parcours navigateur p6b (J1/J3/J4 + isolation) | **26/26** |
| Parcours navigateur cloture (J2/J4 ORDER/désactivation/refus) | **33/33** |
| down.ps1 refus (Test A/B) + bon chemin | **3/3** |

---

## Revue V3 — les trois écarts résiduels corrigés (11/10/2026)

> GO `docs/GO-CORRECTIONS-REVUE-V3.md`. Les preuves **distinguent** la nature : lecture de
> code (**statique**), Jest avec barrières Promise (**unit**), PostgreSQL réel + simulateur
> loopback (**e2e socle**). **Aucun** appel Stripe test réel ni live (étape distincte, hors GO).

### Écart 1 — exclusion des dispatchs et réponses tardives
`CardPayment`/`Refund` ont désormais `dispatchOwner`/`dispatchClaimedAt` (migration additive
`20261011000001_dispatch_identity`, bases isolées uniquement). L'acquisition est un CAS
exclusif owner-conditionné (lease 60 s, jeton `timestamp:uuid`) ; une acquisition refusée ne
**vie** jamais d'appel réseau ; toutes les écritures résultat sont bornées `{ id, dispatchOwner }`.
Le 409 prestataire est classé **incertain** (jamais refus certain). Même correction dans
`enterDispatch` des remboursements. **Unit** : un seul envoi sous tentative vivante, réponse
tardive dépossédée sans effet, lease expiré → reprise bornée, 409 jamais refus certain.

### Écart 2 — configuration exactement testée
`checkConnection` lit **un seul** snapshot avant de bâtir le connecteur ; le CAS de la preuve
soumet l'`updatedAt` observé ; toute édition pendant `verifyAccount` invalide l'enregistrement
(succès **comme** échec). **Unit** : 1 lecture, CAS sur la version observée, édition pendant le
réseau → Conflict « Configuration modifiée pendant le contrôle », zéro écriture frauduleuse.

### Écart 3 — identité source durable des webhooks
`PaymentWebhookEvent` persiste `merchantAccount`/`sourceSettingId`/`sourceConfigVersion` au moment
de la réception (même contexte `WebhookAuthContext` que la vérification de signature, 1 lecture).
`reconcileDue` n'utilise **jamais** la configuration courante : il rejoue sous l'identité
d'origine. Un ancien événement sans identité → **FAILED visible** (`reconcileAt: null`, message
d'intervention), sans origine inventée. **Unit** : réception sous A → rotation vers B → rejeu
attribué à A ; doulon post-changement ; legacy sans identité.

### Résultats de la consolidation V3 (11/10, socle)

| Contrôle | Résultat |
|---|---|
| tsc API / nest build / next build | **0 / 0 / 0** |
| `git diff --check` | **0** |
| Unit complet | **1420/1420 (74 suites)** |
| 4 specs paiement ciblés (130 tests) | **130/130** |
| e2e ciblés socle (refund-accounting, order-card-payment, card-topup, stripe-no-simulator) | **87/87** |

### Incident migration (non masqué, réversé)
Un `prisma migrate deploy` sans override `DATABASE_URL` avait appliqué 6 migrations sur
`icode_host_pro` (tables créées **vides**) ; **inversion SQL exacte** exécutée et vérifiée
(60 migrations, zéro artefact), puis déploiement correct de `20261011000001_dispatch_identity`
sur `icode_host_pro_socle` et `icode_host_pro_recette` **seulement**. **Dossier complet** :
`docs/DOSSIER-INCIDENT-MIGRATIONS.md` (commandes réelles, chronologie, journaux sans secrets,
démontré / déclaré / non vérifiable). Le retour arrière n'efface pas l'incident.

### Correction de test (non code) — D2/E3 `order-card-payment`
Les assertions D2/E3 comptaient les wallet transactions du client en **absolu** (`toBe(0)`) :
si la course C3 gagnait par le portefeuille, une transaction **légitime** subsistait et faussait
la mesure. Passées en **delta nul** (l'invariant réel : le règlement carte ne crée **aucun**
mouvement) ; D2 accepte `[PAID, ACTIVE]` (provisioning post-commit asynchrone, déjà le cas de D3).

Aucun appel Stripe externe, aucun paiement réel, aucun commit — interdits de ce GO respectés.

---

## Revue V5 — fermeture des deux défauts V4 + incident (11/10/2026)

> GO `docs/GO-CLOTURE-DEFAUTS-V4-INCIDENT.md`. Aucun nouvel appel Stripe, aucun paiement réel,
> aucune écriture nouvelle sur `icode_host_pro`, aucun affaiblissement d'assertion.

### Défaut 1 — réponse tardive après confirmation webhook
Toutes les écritures webhook terminales (`settleTopupInTx`, `settleOrderInTx`/`common`,
branche `review`, branche incohérence `confirmPaid`, `markExpired`, `markFailed`) invalident
la revendication (`dispatchOwner: null`). Les écritures incertaines/échec tardives sont
bornées `{ id, dispatchOwner: owner, providerCallState: 'DISPATCHED' }` : une décision
établie n'est **jamais dégradée**. **Unit** (6 tests, TOPUP + ORDER) : appel suspendu par
gate réseau contrôlée → webhook confirme → réponse tardive (timeout / refus 402 / succès)
→ SUCCEEDED et `RESOLVED` conservés, propriétaire invalidé, **1 seul** crédit / **1 seul**
règlement, aucun audit mensonger, références webhook inchangées. Concurrence entre
propriétaires (V3 §1) inchangée. Synchronisation des tests ORDER déterministe sur le
commit du CAS de reprise (aucun polling arbitraire).

### Défaut 2 — identité webhook persistée atomiquement
`dedupe()` persiste l'événement **et** son identité source dans le **même `create`**.
Échec de persistance → exception → 500 (rejeu prestataire), **zéro effet métier**,
**zéro acquittement**. Rejeu (P2002) : complétion d'identité uniquement sur ligne sans
identité (CAS `merchantAccount: null`), **jamais d'écrasement** ; l'identité d'origine
prime sur la configuration courante. **Unit** (3 tests V5 §2) : échec persistance sans
effet ; interruption après inscription durable → reprise sous identité d'origine après
rotation A→B (zéro réattribution) ; doublon d'un événement traité sous B → doublon
neutre, 1 seul traitement, ligne inchangée sous A.

### Incident — dossier + garde
Dossier : `docs/DOSSIER-INCIDENT-MIGRATIONS.md` (6 migrations, commandes d'application
et d'inversion, journaux joints sans secrets, date de l'en-tête corrigée 12/10 → 11/10).
Garde : `recette/db-url.ps1` (liste blanche des bases isolées) + `recette/db-guard.mjs`
(refus sans `DATABASE_URL`, aucun repli `.env`). Tests de refus **sans migration** :
refus `icode_host_pro` exit 1 ; refus construction d'URL exception ; refus sans URL
exit 1 ; accepte base isolée avec URL explicite exit 0.

### Résultats de la consolidation V5 (11/10, socle)

| Contrôle | Résultat |
|---|---|
| tsc API / nest build / next build | **0 / 0 / 0** |
| `git diff --check` | **0** |
| Unit complet | **1429/1429 (74 suites)** |
| 4 specs paiement ciblés | **136/136** |
| e2e ciblés socle | **87/87** |

### Limites (V5)
Preuves unit sur mocks (intercalages pilotés par barrières Promise) ; état de `icode_host_pro`
**avant** le deploy erroné non sauvegardé (non vérifiable ligne à ligne hors objets du lot et
`_prisma_migrations`) ; garde limitée aux scripts recette (contournement possible hors scripts) ;
Stripe test réel et activation production hors périmètre.

---

## Revue V6 — reprise webhook sans identité durable + rectification dossier incident (11/10/2026)

> GO `docs/GO-DERNIERE-CORRECTION-V6.md`. Aucun nouvel appel Stripe, aucun paiement réel,
> aucune écriture nouvelle sur `icode_host_pro`, aucun affaiblissement d'assertion.

### §1 — reprise webhook sans identité durable (corrigé)
Le chemin défaillant identifié : `dedupe()` retrouve une ligne `RECEIVED`/`FAILED` sans
`merchantAccount` ; l'`updateMany` de complétion échouait et **son erreur était absorbée** ;
la relecture pouvait échouer et **revenir à `existing`** ; `handleSignedPayload` utilisait
`sourceIdentity ?? auth.identity` ; le traitement continuait et renvoyait **200 sans identité
persistée**.

Corrections (`payment-webhook.service.ts`) :
- `const identity = eventRow.sourceIdentity;` — le repli `?? auth.identity` (configuration
  courante) est **supprimé** : le dispatch n'utilise **que** l'identité durable de la ligne.
- `dedupe()` : plus aucune erreur de persistance/relecture absorbée. Le CAS de complétion est
  **contrôlé** par une relecture de l'identité **effectivement enregistrée** (`findUnique` par
  id) ; le résultat retourné est cette identité relue, jamais `existing` en repli. Une
  exception remonte (500 = rejeu prestataire). Si la relecture ne montre **pas** d'identité
  (complétion non justifiable), `sourceIdentity` est `null` → refus **503/FAILED** explicite,
  événement conservé pour intervention.
- **Unit** (5 nouveaux tests `V6 §1`) : (a) écriture refusée → exception propagée, zéro effet ;
  (b) relecture interrompue → aucune poursuite sans preuve durable ; (b′) relecture sans
  identité → refus 503/FAILED, événement conservé ; (c) course de complétion → identité du
  **gagnant** (`acct_winner`) relue et utilisée pour le dispatch, **jamais** celle du perdant
  (`acct_loser`) ; (d) reprise nominale sous `acct_replay` (complétion persistée + dispatch),
  puis doublon → 1 seul traitement, ligne inchangée.

### §2 — rectification du dossier incident
`docs/DOSSIER-INCIDENT-MIGRATIONS.md` rectifié (conclusions absolues → formulations limitées
aux preuves) : « impact métier : aucun », « base revenue à son état antérieur » et « désormais
empêché » remplacés. `check-dev-db.sql`/`revert-dev-db.sql` traités comme des **scripts** (ils
ne prouvent **pas** leurs résultats d'exécution, conservés sans leur sortie). §4/§5 convertis en
**démontré / déclaré / non vérifiable**. La garde est circonscrite à **ses chemins appelants**
(elle n'empêche pas une commande Prisma lancée manuellement). L'incident reste **déclaré** ;
l'absence de sauvegarde préalable et l'impossibilité de certifier l'état avant/après sont
conservées.

### Résultats de la consolidation V6 (11/10, socle)

| Contrôle | Résultat |
|---|---|
| tsc API / nest build / next build | **0 / 0 / 0** |
| `git diff --check` | **0** |
| Unit complet | **1434/1434 (74 suites)** |
| Specs paiement (5 fichiers) | **153/153** |
| e2e ciblés socle | **87/87** |

### Limites (V6)
Preuves unit sur mocks (cas limites pilotés) ; dossier incident : scripts conservés **sans
leur sortie** (résultats déclarés, pas démontrés), instantané **avant** le deploy erroné jamais
pris ; garde = périmètre des chemins appelants uniquement ; Stripe test réel et activation
production hors périmètre.
