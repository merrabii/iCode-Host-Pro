# DESIGN SYSTEM — iCode Host Pro (ADR-023)

> **Origine — RÉFÉRENCE VISUELLE PRIORITAIRE** : la page HTML fournie par le propriétaire
> (dashboard d'hébergement, thèmes dark/light). Le présent document reproduit **son style et
> ses couleurs à l'identique** (sidebar, topbar, cartes, badges, typographie, effets). Tout le
> **contenu métier** de la page de référence (WordPress, Arum, Cloudflare, panneaux tiers…)
> est volontairement **ignoré** : couleur et style uniquement.
>
> Statut : **APPROVED** (2026-08-31, GO explicite du propriétaire : « Ne copier que le style et
> couleurs complet … et oublier tout le reste »).

---

## 0 — Principes (règles non négociables)

1. **Reproduire, ne pas réinterpréter.** Les valeurs ci-dessous sont celles de la référence,
   extraites telles quelles. Toute modification de couleur/effet doit d'abord passer par une
   question au propriétaire.
2. **Brand-agnostic.** Aucun élément de design ne porte le nom, le logo ou le contenu d'une
   marque (ni iCode Host Pro, ni Code Diali, ni une marque tierce de la référence). La marque
   vit **uniquement** dans `apps/web/src/config/brand.ts` + les tokens `--brand-*`.
3. **Tout est modifiable.** Chaque couleur, dimension, police et effet est une **variable CSS**.
   Un rebrand = changer `brand.ts` + les tokens `--brand-primary*` ; pas de CSS figé dans les pages.
4. **Pas de framework CSS.** CSS natif + variables CSS, comme la référence. Les classes
   composant sont globales (`globals.css`) et réutilisables à l'identique.
5. **Thème = `data-theme` sur `<html>`.** `dark` par défaut, persisté en `localStorage`
   (`ihp-theme`), anti-FOUC via script inline dans `layout.tsx`.
6. **Zéro style inline métier.** Les pages ne contiennent ni `style={}` de communication ni
   couleurs en dur : uniquement les classes du système.

---

## 1 — Tokens de la référence (copiés à l'identique)

Couleur primaire de marque : **`#00b377`** (`--green`) / **`#009966`** (`--green-dark`).

### 1.1 Dark (défaut)

| Token | Valeur |
|---|---|
| `--bg` | `#070c1f` |
| `--sidebar-bg` | `#030718` |
| `--header-bg` | `#0d1526` |
| `--card-bg` | `#0d1629` |
| `--card-bg-2` | `#0b1322` |
| `--border` | `#1c2740` |
| `--border-soft` | `#16203a` |
| `--text-primary` | `#ffffff` |
| `--text-secondary` | `#94a3b8` |
| `--text-muted` | `#5b6b85` |
| `--active-bg` | `rgba(0,179,119,.14)` |
| `--active-text` | `#34d399` |
| `--hover-bg` | `#0f1930` |
| `--input-bg` | `#0c1425` |
| `--shadow` | `0 8px 24px rgba(0,0,0,.35)` |

Badges (pill) dark : cloud `rgba(20,184,166,.15)/#2dd4bf` · phase `rgba(139,92,246,.18)/#a78bfa` ·
store/prov `rgba(0,179,119,.15)/#34d399` · clients `rgba(59,130,246,.15)/#60a5fa` ·
hestia `rgba(217,70,239,.15)/#e879f9` · records `rgba(99,102,241,.18)/#a5b4fc` ·
actifs `rgba(148,163,184,.15)/#cbd5e1` · membres `rgba(99,102,241,.2)/#a5b4fc`.

Icon tiles : globe `rgba(0,179,119,.15)/#10d78f` · server `rgba(59,130,246,.15)/#3b82f6` ·
storage `rgba(139,92,246,.18)/#a78bfa` · shield `rgba(217,161,6,.18)/#eab308`.

### 1.2 Light

| Token | Valeur |
|---|---|
| `--bg` | `#f8fafc` |
| `--sidebar-bg` | `#f9fafc` |
| `--header-bg` | `#ffffff` |
| `--card-bg` | `#ffffff` |
| `--card-bg-2` | `#ffffff` |
| `--border` | `#e7eaf0` |
| `--border-soft` | `#eef0f4` |
| `--text-primary` | `#10151f` |
| `--text-secondary` | `#64748b` |
| `--text-muted` | `#94a3b8` |
| `--active-bg` | `#ecfdf5` |
| `--active-text` | `#009966` |
| `--hover-bg` | `#f1f5f9` |
| `--input-bg` | `#ffffff` |
| `--shadow` | `0 1px 3px rgba(16,24,40,.06), 0 1px 2px rgba(16,24,40,.04)` |

Badges/icônes light : déclinaisons pastel (`rgba(…,.1)` / teintes foncées) dérivées des mêmes
teintes, documentées dans `globals.css`.

### 1.3 Typographie & dimensions

- Polices : `--font: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif` ;
  `--mono: "SF Mono", "JetBrains Mono", Consolas, monospace`.
- Layout : sidebar **280px** (`--sidebar-w`), topbar **64px** (`--topbar-h`), padding main **24px**.
- Rayons : hero **16px**, carte/panneau **14px**, nav-item/bouton **9px**, inputs/pills **8px**, badges `999px/5px`.
- Effets : bouton primaire `box-shadow: 0 4px 14px rgba(0,179,119,.3)` ; transitions `background .2s ease, color .2s ease`.
- Gradients : logo `linear-gradient(135deg, var(--green), var(--green-dark))` ; avatar `linear-gradient(135deg,#818cf8,#c026d3)`.
- Titres : logo `135deg` gradient · `h1` 27px/800 · numéro stat 26px/800 · titre panneau 15.5px/700 ·
  nav-item 13.5px/500 · bouton 13px/600 · libellé section 10.5px/700 uppercase `ls:.05em` · stat-sub 11.5px mono.
- Breakpoints : 1100px (stats 2 col, bottom 1 col) · 900px (sidebar masquée) · 600px (stats 1 col).

---

## 2 — Composants (classes globales dans `globals.css`)

### 2.1 Shell & topbar
`.shell`, `.topbar`, `.topbar-left`, `.logo-badge` (initiale de marque, gradient), `.brand-title`,
`.brand-sub`, `.pill-tag`, `.topbar-mid`, `.info-pill(.dot)`, `.topbar-right`, `.theme-toggle`,
`.btn-primary`, `.user-chip`, `.avatar`, `.user-name`, `.user-role`, `.icon-btn`.

### 2.2 Sidebar
`.sidebar`, `.tenant-label`, `.tenant-box` (+ `.chevron`), `.nav-section-label`, `.nav`,
`.nav-item(.active)` avec `.nav-item-left` + icône + label + `.nav-badge` (variantes
`.ok .info .violet .warn`), `.refresh-btn`, `.sidebar-foot`, `.foot-status(.dot)`, `.foot-user`.

### 2.3 Héros / stats / panneaux
`.hero` (`.hero-eyebrow`, `.hero-cta`), `.stats-grid`, `.stat-card` (`.stat-top`, `.stat-label`,
`.stat-icon.primary/.info/.violet/.amber/.neutral`, `.stat-value`, `.stat-sub(.warn)`),
`.bottom-grid`, `.panel` (`.panel-head`, `.panel-title`, `.panel-link`, `.panel-sub`),
`.status-pill`, `.status-row` (`.status-icon`, `.status-row-title`, `.status-row-sub`).

### 2.4 Ajouts produits dans le style de la référence (documentés)
La référence n'a ni formulaires, ni tables, ni états, ni rouge — ajouts réalisés **dans les mêmes
tokens/teintes** pour que l'app soit fonctionnelle :
- **Boutons** : `.btn-primary` (réf.) + `.btn-secondary` (input-bg + border) + `.btn-danger` (teinte rouge).
- **Formulaires** : `.input`, `.select`, `.field label`, `.check-row` (case inline), focus ring `--brand-accent`.
- **Table** : `.table` (entête uppercase label, lignes séparées `--border-soft`), cellules compactes.
- **Messages** : `.alert.ok` (vert), `.alert.error` (rouge), `.alert.info` (bleu).
- **États** : `.empty` (vide), `.spinner` (petit loader marque), `:focus-visible` (ring),
  `:disabled` (50 % + `not-allowed`).
- **Badges sémantiques** : `.badge` + `.badge-ok` / `.badge-info` / `.badge-warn` / `.badge-danger` / `.badge-neutral` / `.badge-violet`
  → mappés sur les teintes de la référence (green=store, blue=clients, violet=records, amber=shield)
  pour exprimer les statuts métier (ACTIVE, PENDING, SUSPENDED…).

---

## 3 — Layout des zones de l'application

- **`/auth`** : écran plein centré (`.auth-wrap`) — carte `--card-bg`, border, radius 16, ombre ;
  pas de sidebar. Topbar minimal avec logo.
- **`/manager` et sous-pages** : `AppShell` complet (topbar `--header-bg` + sidebar `--sidebar-bg`
  + nav ADMIN) ; contenu dans `.main` (hero/stats/panneaux) puis panneaux de gestion.
- **`/client`** : `AppShell` avec nav Espace client ; mêmes composants.
- **Contenu métier** : instance `.demo.hero`, pages = héros/stat-cards/panneaux (dashboard), ainsi que
  `.panel` + `.status-row` / `.table` + `.alert` + formulaires pour la gestion.

---

## 4 — Règles d'écriture

- **Classe → composant** : pas de JSX partagé obligatoire ; les classes globales sont le contrat.
  Les petits wrappers (`ui/`) ne sont qu'un confort, pas une nécessité.
- **Couleurs** : toujours via token ; jamais de valeur hex dans une page.
- **Sémantique vs fidélité** : une teinte de la référence est réutilisée par sa **fonction visuelle**
  (ex. green = succès/actif). Changer une teinte = changer le token, l'app entière suit.
- **Thème** : tout composant doit être lisible dans les deux thèmes (se re-tester en light/dark).
- **Contenu** : les noms de panneaux tiers de la référence sont interdits ; on utilise le vocabulaire
  métier réel de iCode Host Pro (Produits, Serveurs, Utilisateurs, Journal, Invitations, Mail,
  Souscriptions & services, Espace client).
- **Responsive** : sidebar/topbar-mid disparaissent < 900px ; stats < 1100px.

---

## 5 — Configuration marque (rebrand)

`apps/web/src/config/brand.ts` est **le seul endroit** qui nomme la marque :
nom, sous-titre, tag de pilule (optionnel), initiales du logo. Le rebrand différé
« iCode Host Pro → Code Diali » (codediali.com, décision propriétaire) = modifier ce fichier
+ les tokens `--brand-primary` / `--brand-primary-dark` dans `globals.css`. Rien d'autre.
