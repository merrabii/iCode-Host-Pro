# DESIGN HANDOVER — pour l'agent design (séparation présentation / fonctionnelle)

> Ce document est le **point d'entrée d'un futur agent dédié au design** (ex. Gemini).
> Il décrit la séparation **présentation / fonctionnelle** du front, la carte des
> fichiers et les règles impératives. La **référence visuelle autoritaire** reste
> [DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md) (ADR-023, validée propriétaire) — à lire d'abord.

---

## 1. Règles impératives (à respecter AVANT toute modification)

1. **Ne jamais toucher au fonctionnel.** Le design vit dans les pages/components
   `src/app`, `src/components` — pas dans `src/lib`, `src/config/nav.ts`,
   `src/config/brand.ts` (sauf besoin de marque explicite) ni l'API NestJS.
2. **Charte intouchable** : tokens `--brand-*` + palette `DESIGN_SYSTEM.md`.
   Aucune couleur en dur dans les pages (uniquement les classes/variables du
   système). Toute évolution visuelle = demande au propriétaire d'abord.
3. **Brand-agnostic** : le design ne contient ni nom, ni logo de marque
   (iCode Host Pro / Code Diali). La marque vit uniquement dans `brand.ts`.
4. **Pas de framework CSS** : CSS natif + variables CSS (`globals.css`).
5. **Thème** : `data-theme` sur `<html>` (dark défaut, persisté `ihp-theme`,
   anti-FOUC dans `layout.tsx`). Toute nouvelle couleur doit exister en dark
   ET light.
6. **Accessibilité / responsive** : layouts fluides, `max-width:100%`, breakpoints
   1100/900/600px, focus visibles, labels de formulaire.
7. **Vérification obligatoire après tout changement** :
   `npx tsc --noEmit` (web) puis `corepack pnpm --filter @icode-host-pro/web build`
   — dev arrêté + purge `.next` avant build (leçon Phase 2).
8. **Ne pas réécrire les pages métier** : restructurer le design = modifier
   composants et CSS partagés ; la logique de page (chargement, mutations,
   guards) reste en place.

## 2. Carte des fichiers — séparation stricte

### Fonctionnel (NE PAS modifier pour du design)
| Fichier | Rôle |
|---|---|
| `src/lib/api.ts` | Tous les appels API (types, helpers, fetch) — couche de données |
| `src/lib/session.ts` | Session / rôles (useAdminSession, useSupportSession, roleRank…) — contrôle d'accès |
| `src/config/brand.ts` | Marque (nom, tagline) — point unique de rebrand |
| `src/config/nav.ts` | Navigation par rôle (ADMIN_NAV / SUPPORT_NAV / CLIENT_NAV) |
| `apps/api/**` | Toute l'API NestJS (hors front) |

### Présentation (la zone de travail du design)
| Fichier | Rôle | Surfaces notables |
|---|---|---|
| `src/app/globals.css` | TOUS les tokens + classes composant | palette, layout, composants, responsive, `data-theme` |
| `src/components/ui.tsx` | Kit UI partagé | `Panel, Button, Badge, Field, Input, Select, PageIntro, EmptyState, PageLoading, Denied, Alert, statusTone` |
| `src/components/app-shell.tsx` | Shell (sidebar, topbar, tenant, nav) | `AppShell, ImpersonationBanner, NavSection` |
| `src/components/icons.tsx` | Icônes SVG inline (léger, cohérent) | `Icon*` |
| `src/components/toast.tsx` | Toasts | `useToast` |
| `src/components/theme-toggle.tsx` | Bascule dark/light | |
| `src/components/turnstile.tsx` | Widget Turnstile (script CDN si clé) | |

### Pages (présentation + logique de page — restylables, ne pas casser la logique)
| Page | Surface design |
|---|---|
| `src/app/page.tsx` | Landing publique (Phase 11) |
| `src/app/offres/page.tsx` | Catalogue public + parcours commande |
| `src/app/auth/page.tsx` | Connexion / inscription à la commande / MFA / OAuth |
| `src/app/aide/page.tsx` | Centre d'aide public (articles CLIENT PUBLISHED) |
| `src/app/client/page.tsx` | Espace client (catalogue, souscriptions, services, code support, tickets, bandeau impersonation) |
| `src/app/profil/page.tsx` | Mon profil (MFA, fournisseurs liés, mot de passe) |
| `src/app/manager/page.tsx` | Tableau de bord admin |
| `src/app/manager/{serveurs,produits,utilisateurs,subscriptions,invitations,mail,journal,securite,support,connaissance}/page.tsx` | Console admin (10 pages) |

## 3. Composants & conventions clés (résumé pour l'agent)

- **Layout** : sidebar 280px, topbar 64px, padding main 24px ; admin en
  `wrap-lg` (1320px), pages légères en `wrap-md`.
- **Panneaux** : `Panel title sub` (carte), `.stack` pour la liste verticale,
  `.status-row` pour les lignes liste, `.table` / `.table-wrap` pour les tableaux.
- **Badges** : `statusTone(status)` → ton `ok/warn/neutral/violet/info` selon le statut.
- **Drawer/éditeur** : `.drawer-overlay` + `.drawer` (lecture article /aide,
  éditeur base de connaissance, drawer serveurs).
- **Héro/aide** : classes `aide-*` (hero, search, chips, grid, cards) et `offres-*`.
- **Auth** : `.auth-wrap` / `.auth-card` (login).
- **Impersonation** : `ImpersonationBanner` (bandeau rouge admin / bleu support) —
  prop `banner` de `AppShell`.
- **Toasts** : `useToast()` (`toast.ok / toast.error / toast.info`).

## 4. Comportements fonctionnels à préserver (ne pas « simplifier »)

- Boutons désactivés pendant les actions (`busy`), guards d'accès (Denied),
  état de chargement (PageLoading), empty states, messages d'erreur français.
- L'espace client **n'expose jamais de données d'infrastructure** (serveurs).
- Les formulaires envoient via `src/lib/api.ts` — ne pas les remplacer par du
  HTML natif sans passer par la couche existante.
- Les bandeaux d'impersonation et les états MFA/OAuth sont **fonctionnels**.

## 5. Périmètre volontairement hors-design (pour mémoire)

- Aucune page de facturation/paiement (abonnement « mensuel » sans prix — wording).
- Phase 10bis (déploiements GitHub→Coolify) : panneau « Déploiements » à prévoir
  sur `/client` quand la fonctionnalité existera.
- Rebrand → Code Diali : **uniquement après** la fin du projet (changer
  `brand.ts` + tokens `--brand-*` ; mémorisé, ne pas devancer).
