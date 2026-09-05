# DESIGN SYSTEM — iCode Host Cloud

> **Statut : OBLIGATOIRE.** Ce document définit le système de design unique du projet iCode Host.
> Toute page créée, modifiée ou refactorisée — par n'importe quel modèle ou outil (Claude Code, Cursor, Copilot, humain) — **DOIT** respecter strictement ces règles. Aucune nouvelle palette, aucun nouveau composant "ad hoc", aucune librairie UI externe (Bootstrap, MUI, Ant Design, etc.) ne doit être introduite sans passer d'abord par une mise à jour de ce fichier.
>
> Si une page existante ne respecte pas ce document, elle est considérée comme **une dette technique à corriger**, pas comme une référence valide.

---

## 0. Règles non négociables (à lire en premier)

1. **Toujours utiliser les variables CSS définies en section 2.** Ne jamais coder une couleur en dur (`#059669`, `rgb(...)`, nom de couleur CSS) directement dans un composant. Si une teinte manque, l'ajouter à la section 2 avec un nom cohérent, pas l'inventer localement.
2. **Chaque page doit supporter le thème clair ET le thème sombre** via l'attribut `data-theme="dark"` / `data-theme="light"` sur `<html>`, avec le même mécanisme de bascule que les pages existantes (voir section 7).
3. **La structure de layout (topbar + sidebar + main) est fixe.** Ne pas la réinventer par page — voir section 5.
4. **La sidebar d'une page ne doit afficher que l'entrée de navigation correspondant à la page courante** (marquée `active`), pas la liste complète du menu applicatif. La liste complète du menu vit dans un composant de navigation partagé, pas dans chaque page.
5. **Les icônes sont des SVG inline au trait (stroke), jamais des icônes remplies façon emoji/pictogramme coloré**, sauf pour les puces de statut (`●`) et les chips utilisateur/logo en dégradé. `stroke-width="2"` par défaut.
6. **Rayons, ombres, espacements** suivent l'échelle définie en section 3 — pas de valeurs arbitraires (`border-radius: 7.5px`, `padding: 13px 2px`, etc.).
7. **Toute nouvelle couleur d'accent (badge, statut) doit être dérivée de la palette sémantique en section 2.3**, pas d'une couleur choisie au hasard.
8. Avant de livrer une page, vérifier visuellement les DEUX thèmes (clair/sombre) et le comportement responsive (`≤1100px`).

---

## 1. Direction artistique

- **Ton** : console cloud/infrastructure professionnelle (hébergement managé WordPress, DNS, sécurité). Sobre, dense en information, jamais ludique ou décoratif.
- **Base sombre par défaut, thème clair en option** — les deux doivent être soignés à parité, pas l'un "principal" et l'autre "approximatif".
- **Accent unique : vert émeraude** (`--green`). C'est la seule couleur "action" (boutons primaires, éléments actifs, liens de progression). Les autres teintes (bleu, violet, ambre, rouge, cyan) sont réservées à la **sémantique de statut/catégorie**, jamais à des actions primaires concurrentes.
- **Cartes plutôt que sections pleine largeur** : tout regroupement d'information vit dans une carte (`.card` / panel) avec fond, bordure fine et ombre légère — jamais de blocs flottants sans contour.
- **Densité d'information élevée** mais aérée : padding généreux dans les cartes (20–26px), gaps de 14–18px entre cartes.
- **Typographie** : sans-serif système uniquement (voir 4). Pas de police display, pas de serif. Les libellés de section (`ESPACE MULTI-TENANT`, `MENU NAVIGATION`, en-têtes de tableau) sont en majuscules, petits, `letter-spacing` large, couleur atténuée — c'est le seul endroit où les majuscules sont autorisées.

---

## 2. Couleurs (tokens obligatoires)

Toutes les couleurs sont des **variables CSS** définies dans deux blocs `[data-theme="dark"]` et `[data-theme="light"]`, plus quelques constantes globales dans `:root`.

### 2.1 Constantes globales (identiques dans les deux thèmes)

```css
:root{
  --green:        #00b377;  /* accent primaire (boutons, actif, focus) */
  --green-dark:   #009966;  /* hover / pressed du vert primaire */
  --sidebar-w:    280px;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;
  --mono: "SF Mono", "JetBrains Mono", Consolas, monospace;
}
```

### 2.2 Thème sombre — `[data-theme="dark"]`

```css
[data-theme="dark"]{
  /* Fonds */
  --bg:              #070c1f;
  --sidebar-bg:      #030718;
  --header-bg:       #0d1526;
  --card-bg:         #0d1629;
  --input-bg:        #0c1425;
  --hover-bg:        #0f1930;
  --table-head-bg:   #0b1322;
  --row-hover:       #0f1930;

  /* Bordures */
  --border:          #1c2740;
  --border-soft:     #16203a;

  /* Textes */
  --text-primary:    #ffffff;
  --text-secondary:  #94a3b8;
  --text-muted:      #5b6b85;
  --link:            #60a5fa;

  /* États actifs / ombre */
  --active-bg:       rgba(0,179,119,0.14);
  --active-text:     #34d399;
  --shadow:          0 8px 24px rgba(0,0,0,0.35);

  /* Badges sémantiques */
  --badge-cloud-bg:    rgba(20,184,166,0.15); --badge-cloud-text:   #2dd4bf;  /* tag CLOUD */
  --badge-phase-bg:    rgba(139,92,246,0.18); --badge-phase-text:  #a78bfa;  /* violet — phase/version */
  --badge-247-bg:      rgba(0,179,119,0.15);  --badge-247-text:    #34d399; /* vert — disponibilité */
  --badge-blue-bg:     rgba(59,130,246,0.15); --badge-blue-text:   #60a5fa; /* bleu — clients/records/A */
  --badge-indigo-bg:   rgba(99,102,241,0.18); --badge-indigo-text: #a5b4fc; /* indigo — équipe/records DNS */
  --badge-pink-bg:     rgba(217,70,239,0.15); --badge-pink-text:   #e879f9; /* rose — hestia/cpanel */
  --badge-gray-bg:     rgba(148,163,184,0.15);--badge-gray-text:   #cbd5e1;/* gris — neutre/0/vide */
  --badge-amber-bg:    rgba(217,161,6,0.18);  --badge-amber-text:  #f5b93a; /* ambre — priorité haute/warn */
  --badge-cyan-bg:     rgba(6,182,212,0.15);  --badge-cyan-text:   #22d3ee; /* cyan — résolu/info */

  /* Boutons outline colorés */
  --btn-warn-border:  rgba(245,158,11,0.4); --btn-warn-text:  #fbbf24; --btn-warn-bg: rgba(245,158,11,0.08);
  --btn-danger-border:rgba(239,68,68,0.4);  --btn-danger-text:#f87171; --btn-danger-bg:rgba(239,68,68,0.08);

  /* Icônes de statistique (chips colorées) */
  --icon-green-bg:  rgba(0,179,119,0.15); --icon-green-text:  #10d78f;
  --icon-blue-bg:   rgba(59,130,246,0.15);--icon-blue-text:   #3b82f6;
  --icon-violet-bg: rgba(139,92,246,0.18);--icon-violet-text: #a78bfa;
  --icon-amber-bg:  rgba(217,161,6,0.18); --icon-amber-text:  #eab308;
  --icon-teal-bg:   rgba(20,184,166,0.15);--icon-teal-text:   #2dd4bf;
}
```

### 2.3 Thème clair — `[data-theme="light"]`

```css
[data-theme="light"]{
  /* Fonds */
  --bg:              #f8fafc;
  --sidebar-bg:      #f9fafc;
  --header-bg:       #ffffff;
  --card-bg:         #ffffff;
  --input-bg:        #ffffff;
  --hover-bg:        #f1f5f9;
  --table-head-bg:   #f8fafc;
  --row-hover:       #f8fafc;

  /* Bordures */
  --border:          #e7eaf0;
  --border-soft:     #eef0f4;

  /* Textes */
  --text-primary:    #10151f;
  --text-secondary:  #64748b;
  --text-muted:      #94a3b8;
  --link:            #2563eb;

  /* États actifs / ombre */
  --active-bg:       #ecfdf5;
  --active-text:     #009966;
  --shadow:          0 1px 3px rgba(16,24,40,0.06), 0 1px 2px rgba(16,24,40,0.04);

  /* Badges sémantiques */
  --badge-cloud-bg:    #d9f2ee; --badge-cloud-text:   #0d9488;
  --badge-phase-bg:    #ede9fe; --badge-phase-text:   #7c3aed;
  --badge-247-bg:      #d3f5e6; --badge-247-text:     #059669;
  --badge-blue-bg:     #dbeafe; --badge-blue-text:    #2563eb;
  --badge-indigo-bg:   #e0e7ff; --badge-indigo-text:  #4f46e5;
  --badge-pink-bg:     #fae8ff; --badge-pink-text:    #c026d3;
  --badge-gray-bg:     #f1f5f9; --badge-gray-text:    #475569;
  --badge-amber-bg:    #fef3c7; --badge-amber-text:   #b45309;
  --badge-cyan-bg:     #cffafe; --badge-cyan-text:    #0891b2;

  --btn-warn-border:  #fde68a; --btn-warn-text:  #b45309; --btn-warn-bg: #fff;
  --btn-danger-border:#fecaca; --btn-danger-text:#dc2626; --btn-danger-bg:#fff;

  --icon-green-bg:  #d3f5e6; --icon-green-text:  #059669;
  --icon-blue-bg:   #dbeafe; --icon-blue-text:   #2563eb;
  --icon-violet-bg: #ede9fe; --icon-violet-text: #7c3aed;
  --icon-amber-bg:  #fef3c7; --icon-amber-text:  #d97706;
  --icon-teal-bg:   #d9f2ee; --icon-teal-text:   #0d9488;
}
```

### 2.4 Grammaire d'usage des couleurs (obligatoire)

| Usage | Couleur |
|---|---|
| Bouton primaire, CTA principal, lien "voir tout", élément de nav actif | `--green` / `--active-bg` + `--active-text` |
| Badge "CLOUD" (tag produit) | `--badge-cloud-*` (teal) |
| Badge "PHASE X" / version interne | `--badge-phase-*` (violet) |
| Badge disponibilité / SLA (ex : "24/7") | `--badge-247-*` (vert) |
| Badge client / enregistrement bleu / type "A" | `--badge-blue-*` |
| Badge équipe / records DNS / indigo | `--badge-indigo-*` |
| Badge module serveur (Hestia/cPanel) | `--badge-pink-*` |
| Badge neutre / compteur à 0 / catégorie générique | `--badge-gray-*` |
| Priorité haute / avertissement / clé API | `--badge-amber-*` ou `--btn-warn-*` |
| Statut "résolu" / info secondaire | `--badge-cyan-*` |
| Action destructive (déconnecter, supprimer) | `--btn-danger-*` |

**Ne jamais** utiliser le rouge/danger pour autre chose qu'une action destructive ou une erreur réelle. **Ne jamais** utiliser deux couleurs différentes pour représenter le même statut sur deux pages différentes.

---

## 3. Échelle d'espacement, rayons, ombres

```css
/* Rayons */
--radius-sm: 6px;   /* badges, mini-tags */
--radius-md: 9px;   /* boutons, inputs, nav items */
--radius-lg: 10px;  /* icônes carrées, chips */
--radius-xl: 14px;  /* cartes standard */
--radius-2xl: 16px; /* carte "hero" en tête de page */
--radius-full: 999px; /* pills / badges arrondis / avatars */

/* Espacements (multiples de 2px) */
--space-1: 4px;  --space-2: 6px;  --space-3: 8px; --space-4: 10px;
--space-5: 12px; --space-6: 14px; --space-7: 16px; --space-8: 18px;
--space-9: 20px; --space-10: 22px; --space-11: 24px; --space-12: 26px;
```

- Carte standard : `padding: 20px`.
- Carte "hero" (bandeau de tête de page) : `padding: 22–26px`.
- Grille de cartes stats : `gap: 16px`.
- Grille de panneaux bas de page : `gap: 16px`.
- Ombre unique par thème : `var(--shadow)` — jamais de `box-shadow` custom par composant.
- Bordure de carte : toujours `1px solid var(--border)`, jamais plus épaisse.

---

## 4. Typographie

```css
font-family: var(--font); /* police système, pas de Google Fonts custom */
```

| Élément | Taille | Poids | Couleur |
|---|---|---|---|
| Titre de page (`h1` hero) | 22–27px | 800 | `--text-primary` |
| Titre de panneau (`.panel-title`) | 15.5px | 700 | `--text-primary` |
| Titre de carte de ticket / ligne de liste | 15.5px | 700 | `--text-primary` |
| Corps de texte / description | 13–14px | 400–500 | `--text-secondary` |
| Libellé de section (eyebrow, ex. "MENU NAVIGATION") | 10.5–11.5px | 700 | `--text-muted`, `letter-spacing: .05em`, **majuscules** |
| Nombre statistique (`.stat-num`) | 24–26px | 800 | `--text-primary` (ou couleur sémantique si alerte) |
| Badge / pill | 9.5–11.5px | 700 | couleur sémantique |
| Code / ID / IP / mono (`--mono`) | 11.5–12.5px | 600–700 | `--text-primary` ou `--green` |
| Item de navigation | 13.5px | 500 (700 si actif) | `--text-secondary` (`--active-text` si actif) |

Pas d'italique. Pas de soulignement sauf lien explicite au survol. Line-height body ≈ 1.5–1.55.

---

## 5. Structure de layout obligatoire

```
┌───────────────────────────────────────────────────────────┐
│ TOPBAR (64px, pleine largeur, fixe en haut)                │
│ [logo+brand]   [pills infra: Coolify / Cloudflare]   [thème│
│                                                toggle][CTA][user] │
├───────────┬───────────────────────────────────────────────┤
│           │  main (padding 24px)                          │
│  SIDEBAR  │  ┌─ hero card ──────────────────────────────┐ │
│  280px    │  │ icône + titre + badge + description + CTA│ │
│           │  └────────────────────────────────────────────┘ │
│ tenant    │  ┌────┐ ┌────┐ ┌────┐ ┌────┐  (grille 4 stats) │
│ box       │  └────┘ └────┘ └────┘ └────┘                  │
│ nav (page │  ┌───────────────────┐ ┌──────────────────┐   │
│ courante  │  │ panneau principal │ │ panneau secondaire│   │
│ seulement)│  └───────────────────┘ └──────────────────┘   │
│ refresh   │                                                │
│ footer    │                                                │
└───────────┴───────────────────────────────────────────────┘
```

- **Topbar** : logo (carré 36px dégradé vert) + nom produit + tag `CLOUD` → pills d'infra (`Coolify:`, `Cloudflare Zone:`) → bascule thème → bouton primaire global → avatar utilisateur + rôle → icône déconnexion.
- **Sidebar** (280px, fixe) : label "ESPACE MULTI-TENANT" + sélecteur tenant → label "MENU NAVIGATION" + **le ou les nav-items pertinents à la page** (pas tout le menu applicatif) → bouton "Actualiser l'Infrastructure" (style `--active-bg`/`--active-text`) → pied de sidebar (statut + utilisateur + déconnexion), collé en bas (`margin-top:auto`).
- **Main** : toujours une carte "hero" en premier (icône à gauche, titre + sous-titre, actions à droite), puis une grille de cartes statistiques si pertinent, puis 1–2 panneaux de contenu (liste, tableau, formulaire).
- **Tableaux** : en-tête `--table-head-bg`, lignes séparées par `--border-soft`, hover `--row-hover`, jamais de zébrage (striping).

---

## 6. Composants — classes de référence

Réutiliser ces classes (ou leur équivalent exact si le projet utilise un framework type Tailwind/React) plutôt que d'en recréer :

- `.btn-primary` — bouton d'action principale (fond `--green`, texte blanc, ombre verte légère).
- `.btn-outline` — bouton secondaire (fond `--input-bg`, bordure `--border`).
- `.btn-outline.btn-warn` / `.btn-outline.btn-danger` — variantes sémantiques.
- `.badge-pill` / `.pill-tag` / `.nav-badge` — badges arrondis, toujours fond clair + texte saturé (jamais fond saturé + texte blanc, sauf `.status-connected`-like ponctuels).
- `.stat-card`, `.stat-icon`, `.stat-num`, `.stat-sub` — carte statistique en tête de page.
- `.panel`, `.panel-head`, `.panel-title`, `.panel-link` — panneau de contenu générique.
- `.nav-item` / `.nav-item.active` — élément de navigation sidebar.
- `.status-pill` (+ variante par statut) — pastille d'état (ouvert/en attente/résolu/connecté...).
- `.table-panel table thead/tbody` — tableau de données standard.

Toute nouvelle page doit **d'abord chercher si un composant existant convient** avant d'en créer un nouveau. Un nouveau composant doit suivre la même logique de nommage (`--icon-*-bg/text`, `--badge-*-bg/text`) et être ajouté à ce fichier.

---

## 7. Thème clair/sombre — mécanisme obligatoire

- Le thème est piloté par `data-theme="dark|light"` sur `<html>`.
- Un bouton unique dans la topbar (`#themeToggle`) bascule l'attribut et le libellé ("Thème Sombre" / "Thème Clair") + l'icône (lune/soleil).
- Aucune couleur ne doit être définie hors des blocs `[data-theme="dark"]` / `[data-theme="light"]` (sauf `--green`/`--green-dark`, identiques dans les deux thèmes).
- Défaut recommandé : **sombre**, sauf préférence explicite de l'utilisateur/session.

---

## 8. Icônes

- Style **Feather/Lucide** (traits fins, `stroke-width="2"`, `fill="none"`, coins arrondis `stroke-linecap`/`stroke-linejoin` par défaut).
- Taille standard : 14–17px dans les boutons/cartes, 16px dans la nav, 26px dans les icônes "hero".
- Icônes de statistique : dans un chip carré `border-radius: 9–10px`, fond `--icon-*-bg`, icône `--icon-*-text`.
- Jamais d'icônes emoji, jamais d'icônes remplies multicolores.

---

## 9. Checklist avant de livrer une page

- [ ] Aucune couleur codée en dur — uniquement des `var(--...)`.
- [ ] Fonctionne et reste lisible en thème clair **et** sombre.
- [ ] Topbar + sidebar identiques au reste de l'app (sidebar = uniquement la page courante en nav active).
- [ ] Carte "hero" en tête de page avec icône + titre + description + action(s).
- [ ] Badges/statuts utilisent une couleur sémantique déjà définie en 2.4 (ou nouvellement ajoutée ici si vraiment nécessaire).
- [ ] Rayons/espacements/ombres tirés de la section 3, pas de valeurs arbitraires.
- [ ] Responsive testé à ≤1100px (grilles qui passent en 2 colonnes / colonne unique).
- [ ] Focus clavier visible sur les éléments interactifs (accessibilité).

---

## 10. Évolution de ce document

Ce fichier est la **source de vérité unique**. Toute évolution de palette, de composant ou de layout doit être :
1. proposée et validée (même rapidement) avec le porteur du projet ;
2. répercutée ici avant d'être utilisée dans le code ;
3. jamais improvisée page par page.

Emplacement recommandé dans le repo : `/docs/DESIGN_SYSTEM.md`.
