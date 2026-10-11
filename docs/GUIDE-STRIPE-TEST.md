# Guide — validation Stripe **mode test** (prérequis catégories B, hors simulateur)

> **Statut :** préparation à la validation externe (GO clôture §9, critère **C9.1** ; revue V2 §7b).
> **Marque :** Code Diali (publique) · **Entité :** Code Diali LLC. **Stripe est le prestataire
> déjà choisi** (mode test actuellement) ; **PaymentCloud** est éventuellement **ultérieur**
> (option, décision distincte — jamais présenté comme acquis). **Simulation ≠ Stripe test ≠
> activation live.**
> **Périmètre :** valider la plateforme (Code Diali / iCode Host Pro) contre **Stripe réel en mode
> test** (`sk_test_` / `pk_test_` / `whsec_`). **Distinct** des scripts de simulation (`simulated`)
> utilisés en recette locale, qui **ne valident ni Stripe ni l'infrastructure réelle**.
> **Ce guide ne déclenche aucun appel.** Catégorie **D (live)** : interdite, GO distinct requis.

Ce document liste les prérequis, la configuration, les événements, les parcours et les points de
vérification. Il complète (sans le remplacer) le `recette/GUIDE-RECETTE-STRIPE.md` (simulateur
local) et le `recette/GUIDE-RECETTE-P10.md`.

---

## 1. Prérequis (liste unique — C9.3)

Sans ces éléments, **toute** la catégorie B reste **bloquée** et aucun appel réseau vers Stripe ne
doit être tenté.

| # | Prérequis | Détail |
|---|---|---|
| B1 | **Compte Stripe** (ou accès à un compte existant) | au moins un compte `test` actif, capable de créer des Checkout Sessions Checkout API v1 (mode `payment`) |
| B2 | **Clés test** | `sk_test_…` (secrète), `pk_test_…` (publique), `whsec_…` (signing secret du webhook) — toutes préfixées comme exigé par la plateforme |
| B3 | **Endpoint webhook joignable** | l'API de la plateforme publique, chemins `/api/payments/webhook` — doit être joignable **par Stripe** (pas un simple `localhost` sans tunnel) |
| B4 | **Tunnel / domaine public** (si dev local) | ngrok / Cloudflare Tunnel / reverse proxy — doit conserver le corps **brut** (pas de JSON re-serialisé) et les en-têtes Stripe |
| B5 | **Décision owner** | autorisation écrite explicite (le présent GO **n'autorise aucun appel vers Stripe**) |
| B6 | **Base isolée** | jamais la base dev `icode_host_pro` ; une base dédiée (ex. `icode_host_pro_stripe_test`) + migrations à jour (64 migrations) |

## 2. Configuration admin (mode test strict)

1. Se connecter en **admin** → `/manager/moyens-paiement` → panneau **connecteur**.
2. Enregistrer le prestataire Stripe avec les **clés test uniquement** :
   - clé secrète : doit commencer par `sk_test_` (sinon refus serveur **400**) ;
   - clé publique : `pk_test_…` ;
   - secret webhook : `whsec_…` ;
   - `environment` : **`test` uniquement** (le serveur refuse `live` : 400 + garde `resolve()`).
3. Les secrets sont chiffrés AES-256-GCM (`ENCRYPTION_KEY`) et **jamais renvoyés** (seuls
   `hasSecretKey` / `hasWebhookSecret` / préfixes apparaissent).
4. **« Tester la connexion »** : exige une identité **vérifiée** (§3) — un compte déclaré sans
   vérification reçoit **409** (`ConflictException`). La vérification (`lastCheckAccount`) est
   invalidée à chaque rotation de clé (`save()` efface `lastCheck*`).

## 3. Vérification d'identité (durcie)

La plateforme refuse toute opération (émission, webhook, remboursement) si l'identité du compte
n'est pas **vérifiée** :

- `cardProviderStatus()` : simulateur activé **ou** Stripe test configuré **+ `lastCheckAccount`
  (preuve de vérification)** ;
- webhook : identité = compte **vérifié** ; identité absente/incohérente → **503** non acquittable
  (Stripe renverra l'événement — aucun effet de bord silencieux).

## 4. Webhooks

- **URL** : `https://<domaine-public>/api/payments/webhook` (chemin exact ; signature exigée).
- **Événements à cocher** (Stripe Dashboard → Webhooks → Add endpoint) :
  - `checkout.session.completed`
  - `checkout.session.async_payment_succeeded`
  - `checkout.session.async_payment_failed`
  - `checkout.session.expired`
  - `payment_intent.succeeded`
  - `payment_intent.payment_failed`
  - `payment_intent.canceled`
  - `charge.refunded`
  - `charge.dispute.created`
  - `charge.dispute.closed`
  - (`refund.created` / `refund.updated` / `refund.failed` / `refund.canceled` — gestion interne
    des remboursements)
- **Signature** : HMAC Stripe-Signature sur le **corps brut**. Un corps altéré/re-serialisé →
  **401**. Secret absent → **503**. Corps brut non conservé (`rawBody`) → **400**.
- **Idempotence** : `(providerCode, eventId)` unique ; rejeu = **200 ignored**, aucun double effet.
- **Seul chemin de crédit** : confirmation serveur (`checkout.session.completed` /
  `async_payment_succeeded` / `payment_intent.succeeded`) — trace `cardpay:<id>`.

## 5. Parcours à valider (catégorie B)

Ordre conseillé, chacun avec capture de la réponse HTTP et de l'état en base :

| # | Parcours | Point de contrôle |
|---|---|---|
| B-P1 | Recharge par carte (USD puis EUR) | page hébergée **sans champ de carte**, redirection suivi, crédit atomique tracé, solde +montant |
| B-P2 | Règlement de commande par carte | `CardPaymentKind.ORDER`, **zéro mouvement de portefeuille**, commande `ACTIVE`, référence `CDP-…` |
| B-P3 | Refus carte (carte de test `4000000000000002`) | `payment_intent.payment_failed` → `FAILED`, aucun crédit |
| B-P4 | Remboursement recharge | plafond ≤ encaissé, `SUCCEEDED` + `refundedCents`, trace `cardrefund:` |
| B-P5 | Remboursement commande (card) | `POST /store/admin/orders/:id/refunds` `kind=EXTERNAL_CARD` + `Idempotency-Key` → SUCCEEDED, **aucun wallet**, refus `WALLET_CREDIT` 409 `REFUND_ORIGIN_CARD` |
| B-P6 | Webhook signature invalide | 401, aucun effet |
| B-P7 | Désactivation interrupteur admin | 409 `PAYMENT_METHOD_DISABLED` sur nouvel émission, bouton carte absent côté client |
| B-P8 | Auth 3-D Secure (si applicable) | comportement navigateur + retour d'état |

### Cartes de test (Stripe)

| Numéro | Comportement |
|---|---|
| `4242 4242 4242 4242` | succès immédiat |
| `4000 0000 0000 0002` | refus (`card_declined`) |
| `4000 0025 0000 3155` | 3-D Secure requis (ou 3DS obligatoire selon compte) |

(Date future, CVC au choix en mode test.)

## 6. Authentification supplémentaire

- Stripe test peut imposer **3-D Secure** selon la carte : le parcours hébergé de la plateforme
  s'appuie sur la page Stripe Checkout (ou Embedded) — le retour navigateur se fait sur
  `/checkout/success?orderId=…&ref=CDP-…` (paiement commande) ou le suivi
  `/client/portefeuille/paiement?ref=…` (recharge).
- Vérifier que la **confirmation finale** vient du **webhook** (source de vérité), pas du simple
  retour navigateur (qui peut être absent ou falsifié).

## 7. Rapprochement

- Toute opération `UNCERTAIN` / `NEEDS_REVIEW` non résolue → **409** sur nouveau règlement.
- Intervention admin consultable : `/manager/paiements-carte` (détail + événements) ; rejeu
  webhooks via le sweep de rapprochement (`reconcile.runner` : défaut 60 s, actif).
- Après chaque session de test, rapprocher les montants Stripe (Dashboard test) avec
  `CardPayment.amountCents` / `refundedCents` et les `Refund`.

## 8. Ce que ce guide **ne** garantit pas

- Aucun appel réseau n'est exécuté par la plateforme **en l'état** (catégorie B : **bloquée**).
- Le simulateur local (`simulated`) **n'équivaut pas** à Stripe test : il prouve la mécanique
  interne (états, idempotence, remboursements), pas l'intégration réseau, la signature réelle
  Stripe, ni le 3-D Secure.
- La catégorie **D (production / live)** reste **interdite** sans GO dédié.
