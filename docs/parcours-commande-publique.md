# Parcours public de commande — audit & état (2026-09-03)

Audit du parcours « commander sans compte » **sans paiement** (Phase 10, ADR-027 ;
refonte design Phase 11). Aucune modification de code nécessaire — état vérifié.

## 1. Le parcours réel (bout en bout)

```
Visiteur → GET /offres (catalogue public)
        → clic « Commander » → POST /api/checkout/intent { productId }
              · rate limit 20/min/IP
              · produit ordonnable sinon 404 (DRAFT/DISABLED refusés)
              · JWT signé court (TTL 600 s) → cookie httpOnly `ihp_checkout`
        → /auth?register=1&product=<nom>
              · écran d'inscription : Google | GitHub | email+mot de passe
        → POST /api/auth/register (email+pass)
              · rate limit 5/min/IP
              · EXIGE un checkout intent valide, sinon 403
              · $transaction : création compte (bcrypt) + souscription PENDING
              · consume le intent (cookie effacé)
           OU callback OAuth (scénario 2)
              · même exigence d'intent pour créer un compte hors compte existant
        → espace client : la souscription apparaît « En attente »
        → l'admin approuve (/manager/subscriptions) → ACTIVE
```

## 2. Pièces réelles (vérifiées dans le code)

| Brique | Fichier | État |
|---|---|---|
| Catalogue public | `public-products.controller.ts` + `products.service.findPublicCatalog` | ✅ hors DRAFT/DISABLED |
| Checkout intent | `auth/checkout.service.ts` + `checkout.controller.ts` | ✅ JWT 600 s, cookie httpOnly, rate limit |
| Inscription à la commande | `auth.service.register(dto, productId)` + `auth.controller.register` | ✅ intent requis (403 sinon), $transaction |
| Inscription OAuth à la commande | `oauth.service` (scénario 2 du callback) | ✅ mêmes règles |
| Page /offres | `apps/web/src/app/offres/page.tsx` | ✅ design Phase 11, cartes par type |
| Écran /auth (register) | `apps/web/src/app/auth/page.tsx` | ✅ mode `?register=1` |
| Espace client | `apps/web/src/app/client/page.tsx` | ✅ catalogue = catalogue public (fix 2026-09-03) |

## 3. Vérifications de non-régression (demandé vs implémenté)

- **Inscription libre fermée** : ✅ sans intent → 403. `GET /api/public/products`
  est public, mais la **création** de compte exige l'intent.
- **Compte créé UNIQUEMENT lors d'une commande** : ✅ pour email+pass ET OAuth.
  Un email inconnu sans intent → 403 (jamais d'auto-création).
- **Commande posée sur le compte** : ✅ souscription PENDING créée dans la même
  transaction que le compte.
- **Pas de paiement** : ✅ assumé — l'abonnement est « mensuel » dans le wording,
  mais aucun prix, aucun paiement, aucune facture. La validation d'approbation
  est manuelle par l'admin.
- **Anti-bot** : Turnstile sur login/support si activé (la création de compte à
  la commande est protégée par le rate limit register 5/min/IP).

## 4. Écarts / limites documentés (sans invention — à décider plus tard)

1. **Pas de prix ni d'ordre d'affichage** sur `Product` : le wording des offres
   montre « Abonnement mensuel » sans montant. Une facturation future devra
   ajouter prix + devise + ordre (aucun impact aujourd'hui).
2. **Intent réutilisable** dans son TTL : re-cliquer « Commander » sur un autre
   produit remplace l'intent (comportement simple assumé, ADR-027).
3. **SUSPENDED visible** dans le catalogue public et l'espace client : un produit
   SUSPENDED apparaît mais le bouton Commander est désactivé côté /offres.
   Choix assumé (visible ≠ commandable).
4. **Confirmation par email** de commande : non envoyée (pas de template
   « commande ») — seule l'approbation admin fait évoluer le statut.

## 5. Recommandations (proposition, pas d'implémentation)

- Conserver le modèle actuel ; ajouter une **notification email à la création de
  compte** (mail déjà opérationnel, ADR-022) quand le besoin client le justifie.
- Documenter la divergence wording « Abonnement mensuel » vs pas de prix.
- Toute future phase de facturation devra passer par un ADR dédié.
