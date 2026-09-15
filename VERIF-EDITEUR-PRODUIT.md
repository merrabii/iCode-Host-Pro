# Vérifier & pousser — Éditeur produit admin (front en onglets)

> Écrit pour la reprise en **nouvelle session (admin PowerShell)**.
> Contexte complet + mémoire dans `CLAUDE.md` et `memory/editor-produit-front-verif-en-attente.md` (auto-chargé à la prochaine session).

## État au 2026-09-14
- **Bloc B backend : poussé** (`5dc3167`). ✔
- **Front « édition produit en onglets » : implémenté, NON vérifié ni poussé.** ⏳
- Cause de l'arrêt : le **classifieur de sécurité des commandes de Claude Code** était
  temporairement indisponible (tout `Bash`/`PowerShell` renvoyait
  « *claude-sonnet-5 is temporarily unavailable…* »).

### Si le message d'indisponibilité réapparaît dans la nouvelle session
Le préfixe **`!`** exécute la commande dans votre terminal (contourne le classifieur) :
```
! <commande>
```

## 1. Vérifier le type (apps/web)
```
! cd "C:/Users/mourad.errabii/Documents/Projet iCode Host/apps/web" && npx tsc --noEmit
```
→ Aucune sortie = OK. Corrige les erreurs éventuelles avant de continuer.

## 2. Build Next.js
```
! cd "C:/Users/mourad.errabii/Documents/Projet iCode Host/apps/web" && npm run build
```
→ Doit se terminer sans erreur (`Compiled successfully`).

## 3. Valider manuellement (dev)
Lancer `apps/api` (nest) + `apps/web` (next), connexion admin, `/manager/produits`,
cliquer **`✎ Modifier`** et parcourir **les 8 onglets** :
- **Général** / **Boutique** : comportement inchangé (régression OK).
- **Vitrine** : slug, prix, promo, cycle, couleur, masqué, stock, cross-sell, freePlan.
- **Catégories** : lier / retirer / enregistrer l'ensemble.
- **Options** : créer option + choix, modifier, réordonner, supprimer.
- **Add-ons** : créer / modifier / réordonner / supprimer.
- **Sous-domaines** : enregistrer une règle, la voir, la supprimer.
- **Mise à disposition** : résumé chaîne + changement de méthode de provisioning.
- Vérifier que le client `/shop/<slug>` surface vitrine + options + add-ons.

## 4. Pousser (uniquement si 1 et 2 sont verts)
```
! cd "C:/Users/mourad.errabii/Documents/Projet iCode Host" && git add apps/web && git commit -m "feat(web): édition produit admin en onglets (vitrine Bloc A + onglets Bloc B)" && git push
```
(Si vous voulez que Claude fasse le commit/push avec la ligne d'attribution, laissez le
`!` de côté et demandez-lui directement.)

---
**Fichiers du front** (pour reprise rapide) :
`apps/web/src/components/admin/product-editor.tsx` + `product-{vitrine,categories,options,addons,subdomain,provisioning}-tab.tsx`,
`apps/web/src/lib/api.ts` (+23 fonctions client Bloc B), `apps/web/src/app/manager/produits/page.tsx`.
**Limite connue** : pas de sélecteur de taxe dans l'onglet Vitrine (pas d'endpoint de liste TaxRate).