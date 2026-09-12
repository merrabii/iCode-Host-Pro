# KB — Création d'app client (GitHub → Coolify) : architecture & résolution de problèmes

> **Public :** admins / mainteneurs. **Objet :** comprendre comment le système crée une app
> cliente depuis un dépôt GitHub public sur Coolify, lui pose un sous-domaine Cloudflare, et
> comment diagnostiquer/corriger vite les pannes de création d'app. Couvre la **première app
> client créée avec succès** (Bloc E, 2026-09-10) : config type, problèmes réels rencontrés,
> solutions retenues.

---

## 1. Architecture — comment ça marche

Une commande client déclenche un **provisioning asynchrone** (never blocking) qui exécute les
actions du `ProvisionMethod` associé au produit acheté, dans l'**ordre déclaré** :

```
POST /store/checkout  (paiement simulé → Order PAID)
        │
        ▼
ProvisioningService.provisionOrder(orderId)   (fire-and-forget)
        │  pour chaque action du ProvisionMethod, dans l'ordre:
        ▼
┌─ CONFIGURE_DNS ─► CloudflareService.allocateClientSubdomain()
│     (1er !)        → vérifie dispo réelle (DNS + DB), crée un CNAME proxied
│                     → écrit une row ClientSubdomain → renvoie { subdomain, fqdn }
│
├─ CREATE_APP ────► PanelTransport.createGitApp(target, {repoUrl, branch, buildPack, ...})
│     (ensuite)      → POST /applications/public (Coolify)
│                     → setAppDomain(appUuid, fqdn)  ⚠️ AVANT le déploiement
│                     → applyAppLimits(pack)  ⚠️ OBLIGATOIRE (Bloc 3, voir §6)
│                     → deployApp(appUuid)  le build porte l'étiquette traefik du fqdn
│
└─ GENERATE_SSL ───► best-effort « SSL géré par Cloudflare (proxied) »
```

Clés de bout-en-bout qui font que l'app est **réellement servie en public** :
- Le sous-domaine (`<seed>.arumdigital.com`) est **alloué en 1er** → le fqdn est connu **avant**
  la création de l'app.
- `CREATE_APP` **pose le domaine sur l'app AVANT le premier déploiement** → l'étiquette traefik
  générée au build porte `Host(<sous-domaine>)`.
- Chaîne : CNAME Cloudflare (proxied) → traefik origin → container Coolify. Le client ne reçoit
  **que** `https://<sous-domaine>` — jamais le hostname Coolify.

**Ordre d'actions retenu** (produit « Deploy my GitHub App », method `coolify-github`) :
`CONFIGURE_DNS → CREATE_APP → GENERATE_SSL`.

---

## 2. Config client type validée — première app créée avec succès

Produit test « Deploy my GitHub App » (slug `deploy-github-app`, 49 $/mois), moduleParams :

| Champ | Valeur | Commentaire |
|---|---|---|
| `repoUrl` | `https://github.com/octocat/Hello-World.git` | dépôt GitHub **public** |
| `branch` | **`master`** | ⚠️ la branche PAR DÉFAUT du repo (pas `main` !) |
| `buildPack` | `static` | pas de build applicatif ; Coolify sert les fichiers via un serveur statique |
| `appName` | `deploy-github-app` | nom de l'app côté Coolify |

Résultat observé sur **Coolify v4.1.2** (état sain) :
- `build_pack = static`, `static_image = nginx:alpine`
- `status = running:unknown` (= container up ; « unhealthy » viendrait d'un healthcheck)
- `fqdn` (domaine posé) = `https://<sous-domaine>.arumdigital.com`
- étiquette traefik : `traefik.http.routers.http-0-<uuid>.rule = Host(\`<sous-domaine>.arumdigital.com\`) && PathPrefix(\`/\`)`
- `ports_exposes` : **null ici** (servi correctement) — voir P5 pour les autres build packs.

**⚠️ `static` + `nginx:alpine` = cas particulier important** : pour `build_pack: static`,
Coolify sert les fichiers du repo sans build applicatif. CE type de config est celui de la
première app validée ci-dessus.

---

## 3. Problèmes rencontrés & solutions (playbook admin)

> Ordre d'apparition réel. Chaque panne a sa **cause racine** et sa **solution réutilisable**.

### P1 — App `exited:unhealthy` dès la création (build KO silencieux)
- **Symptôme :** app créée sur Coolify mais `status = exited:unhealthy`, sous-domaine introuvable/503.
- **Cause racine :** `moduleParams.branch: 'main'`, alors que le dépôt `octocat/Hello-World`
  **n'a QUE la branche `master`** (pas de `main`). Le build échoue (checkout de la branche
  introuvable) sans erreur côté API.
- **Correction :** mettre `branch` = la branche réelle du repo. **Vérifier avant de câbler** :
  `git ls-remote https://github.com/<owner>/<repo>.git` → lister `refs/heads/*`.
- **Règle :** ne JAMAIS assumer que la branche est `main`. Pour un repo inconnu, détecter la
  branche par défaut (API GitHub / `ls-remote`) ou laisser l'utilisateur la choisir.

### P2 — `exited:unhealthy` / `running` mais 503 « no available server » (traefik pas routé)
- **Symptôme :** DNS OK (CNAME créé), app running, mais `curl` sur le sous-domaine → `503 no
  available server` (réponse traefik de l'origine, pas Cloudflare).
- **Cause racine (2 sous-causes imbriquées) :**
  1. **`setAppDomain` envoyait le fqdn SANS schéma** (`monapp.arumdigital.com`). Coolify v4.1.2
     le **rejette** : `PATCH /applications/:uuid {domains: "monapp…"}` → `422 Invalid URL`. Il
     exige `https://monapp.arumdigital.com`.
  2. **Ordre des action** : `CREATE_APP` tournait AVANT `CONFIGURE_DNS` → le premier déploiement
     portait l'étiquette traefik interne « sslip », et un domaine posé APRÈS ne régénérait pas la
     route (l'étiquette restait `Host(<uuid>.<ip>.sslip.io)`).
- **Correction :**
  - `setAppDomain` normalise désormais vers `https://<fqdn>` avant le PATCH.
  - **Réordonner** : `CONFIGURE_DNS` **en premier**, et `CREATE_APP` doit **poser le domaine sur
    l'app AVANT `deployApp`** → le build porte la bonne étiquette traefik.
- **Diagnostic décisif :** décoder `custom_labels` de l'app et chercher la règle
  `traefik.http.routers….rule = Host(…)`. Si elle pointe un `.sslip.io`, la route client n'est pas
  posée. **(la réponse 503 « no available server » de Cloudflare = traefik n'a pas de route pour
  ce Host).**

### P3 — `500` / viol FK `ClientSubdomain_deploymentId_fkey` au provisioning store
- **Symptôme :** l'étape `configure_dns` FAILED avec
  `Foreign key constraint violated on the constraint: ClientSubdomain_deploymentId_fkey`.
- **Cause racine :** `allocateClientSubdomain` exigeait un `deploymentId` (FK → `Deployment.id`),
  mais le chemin **store** passe l'**Order id** (il n'y a pas de row `Deployment` pour le tunnel
  boutique) → violation.
- **Correction :** `deploymentId` devient **optionnel** (`deploymentId?: string`) dans
  `allocateClientSubdomain` / `createSubdomainRecord` (schema déjà `String? @unique`). Le chemin
  store n'en passe pas ; le chemin `DeploymentsService` (Phase 10bis) continue d'en passer un réel.
- **Rappel :** le store stocke le fqdn sur l'**Order** (`domainType/domainValue/domainStatus`), pas
  sur un `Deployment`.

### P4 — API répond vite mais l'état se stabilise plus tard (provisioning async)
- **Symptôme :** juste après le provisioning, l'app n'est pas encore running / la route pas posée.
- **Cause :** le build Coolify est **asynchrone** (job queue). Les étapes provisioning
  `SUCCESS` signifient « opération acceptée », pas « container prêt ».
- **Conduite :** poler `GET /applications/:uuid` **et** décoder `custom_labels` jusqu'à
  `running:unknown` **et** `Host(<sous-domaine>)` avant de valider. Compte 40 à 90 s pour un build
  static simple.

### P5 — `ports_exposes` : null vs défini
- **Observé :** `build_pack: static` + `nginx:alpine` peut servir Correctement AVEC `ports_exposes:
  null` (première app validée). Pour d'autres build packs qui écoutent sur un port applicatif
  spécifique (`nixpacks`, `dockerfile`, `dockercompose`), Coolify / traefik a besoin du port
  exposé — ex : apps saines existantes `wacrm` (`ports_exposes: 3000`), `i-code-host…srv`
  (`ports_exposes: 80`).
- **Conduite pour les autres build packs :** poser `ports_exposes` = port servi (ex `80` pour
  nginx, `3000` pour beaucoup d'apps Node) avant/au moment du deploy ; sinon risque de 503.

---

## 4. Check-list diagnostic rapide (pour l'admin)

Un sous-domaine client ne répond pas ? Dans l'ordre :

**(Bloc 3 — sécurité des ressources sur serveur partagé)** Avant de diagnostiquer, rappel :
l'application des limites du pack est **OBLIGATOIRE** (voir §6). Ne JAMAIS laisser une app sans
plafond sur un box partagé.

1. **DNS** : `nslookup <sous-domaine>.arumdigital.com` → doit renvoyer les IP Cloudflare
   proxied (`188.114.x.y` / `2a06:98c1:…`). Sinon : CNAME absent → vérifier côté Cloudflare.
2. **App Coolify** : `GET /applications/:uuid` → `status` doit être `running:*`.
   - `exited:unhealthy` → **P1** (branche) : vérifier `git_branch` attendue vs branche réelle du repo.
   - `running:*` → **P2** : décoder `custom_labels` → la règle traefik doit pointer le
     `Host(<sous-domaine>)`, pas un `.sslip.io`.
3. **Étiquette traefik** bonne mais 503 → regarder `ports_exposes` (P5).
4. **Provisioning** : `GET /store/admin/orders/:id/provision?force=1` (admin) pour relancer une
   étape ratée (idempotent : sous-domaine déjà alloué → repris).

---

## 6. Sécurité des ressources sur serveur partagé (Bloc 3)

Directive sécurité : **un build client lourd ne doit jamais planter le serveur, seulement échouer
l'app**. Toutes les apps d'un même serveur **partagent** les ressources (on ne réserve rien),
chacune étant **plafonnée** par les limites de son pack.

### Principe
- Quand une commande crée une app, le provisioning applique les **limites CPU/RAM du pack**
  (`limits_cpus` / `limits_memory`) via `PanelTransport.applyAppLimits` → `PATCH /applications/:uuid`.
- Coolify plafonne le **container applicatif ET de build**. Un build qui dépasse la RAM du pack
  → **OOM contenu dans le container limité** → l'app passe `FAILED` seule, les autres apps et le
  serveur restent opérationnels.
- **Aucune réservation** : la capacité machine est partagée, chaque app est bornée par son propre
  pack. (Les produits à ressources dédiées/non partagées sont une étape ultérieure.)

### Application des limites : OBLIGATOIRE (fail-closed)
- Les limites sont appliquées aux **deux chemins de création** :
  - `DeploymentsService.create()` (Phase 10bis) : si le pack porte des limites et que
    `applyAppLimits` échoue → la `Deployment` est marquée **FAILED** avec le message
    « Limites pack non appliquées sur serveur partagé — app NON créée ». L'app n'est jamais laissée
    sans plafond sur un box partagé.
  - `ProvisioningService.actionCreateApp()` (store) : idem — un échec d'application des limites
    échoue la step `create_app` (l'ordre reste en PROVISIONING pour relance admin).
- **Mise à niveau d'un abonnement (Commander depuis l'espace client)** : le checkout repointe la
  MÊME souscription, puis `ProvisioningService.syncAppLimits(subscriptionId)` ré-applique les
  limites du **nouveau** pack aux apps **déjà déployées** (resize best-effort par app, données et
  sous-domaines préservés). Même action via l'admin : bouton **« Ré-synchroniser les ressources »**
  sur la page Abonnements.

### Vérification live (GATE A)
- Créer une app avec un **petit pack** (ex. 256 Mo / 0.5 CPU — le « Plan Gratuit », Bloc 6) lançant
  un build lourd (nixpacks Node riche) → le build doit être plafonné/OOM **dans son container**,
  l'app passe FAILED, **le serveur répond toujours** (les autres apps répondent, pas d'OOM serveur).
- Ressources Espace client : le quota d'apps du pack ACTIF est affiché (RAM/CPU par app, max apps),
  `syncAppLimits` re-plafonne les apps existantes après un upgrade.

---

## 5. À retenir pour tester D'AUTRES build packs (suite)

La première app validée est `build_pack: static` (`nginx:alpine`). Pour étendre à
`nixpacks` / `dockerfile` / `dockercompose`, les points de vigilance :
- **branche réelle** du repo (P1) — à re-vérifier pour chaque nouveau repo.
- **port exposé (`ports_exposes`)** : à renseigner = port du container (P5) ; pour beaucoup
  d'apps : `80` (nginx), `3000` (Node), `8000` (Python), etc.
- **build_pack** modifiable côté Coolify via `PATCH /applications/:uuid { build_pack: … }`,
  puis `deployApp` (toujours poser le domaine avant deploy — P2).
- **client pouvant modifier (domaine, ports, build type) + redeploy** : surface à exposer depuis
  l'espace client (PATCH du domaine/ports/build_pack réutilise `setAppDomain` + un `deployApp`).
  Voir la fiche KB attenante sur l'espace client.