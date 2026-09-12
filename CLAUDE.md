# CLAUDE.md — Architecture de la plateforme (déploiement du projet lui-même)

Ce fichier pose les décisions DUrables d'architecture de **la plateforme elle-même** (le code
de ce repo : Code Diali / iCode Host Pro) — distinctes de la gestion/du déploiement des **apps
clients**. À relire à chaque session avant de raisonner sur « la prod », les redéploiements et
l'installation.

## 1. Ce repo = la plateforme, pas une app client
Le code de ce repo est la plateforme (backend API NestJS + frontend) qui permet à des **clients**
de créer des comptes et d'héberger **leurs propres apps**. Les apps déployées/appartenant aux
clients vivent ailleurs (sur les serveurs de panneau). Tout ce qui est dans `Deployment` /
Redéploiement d'apps dans ce repo concerne des apps de clients, pas la plateforme.

## 2. Développement actuel = local ; `git push` = checkpoint, PAS un déploiement
- La plateforme est **en développement local** en ce moment.
- Le `git push` vers GitHub (`merrabii/iCode-Host-Pro`) n'est qu'un **checkpoint de la dernière
  version opérationnelle**. Pousser n'équivaut **jamais** à un déploiement en prod.
- En dev, la plateforme tourne **en local** (base Postgres `icode_host_pro` dans le conteneur
  `icode-postgres`, port 5432) mais **communique avec un vrai serveur Coolify réel**
  (`portal.arumdigital.com`) où les clients créent réellement leurs comptes et hébergent leurs apps.

## 3. Topologie cible en production
Une fois prête, la plateforme sera installée sur un **VPS séparé**, **distinct** du/des serveur(s)
Coolify qui hébergent les apps clients. La base Postgres de la plateforme vivra aussi sur ce VPS
(nom/adhérences infra actuels `icode-postgres` / `icode_host_pro` / `@codediali/*` à conserver).

## 4. La plateforme est agnostique du panel d'hébergement des apps clients
- Le panel qui héberge les apps clients est un **détail d'implémentation interne**, jamais exposé
  aux clients (jamais d'UUID Coolify, de nom d'app, de hostname serveur, de routes `/api/*` du
  panneau, ni dans l'UI, ni dans les emails).
- **Aujourd'hui : Coolify.** **Demain : d'autres possibles** (Hestia est déjà utilisé pour du suivi
  de métriques serveur). Abstraction = `PanelTransport` / `PanelTransportFactory`
  (`apps/api/src/servers/panel-transport.factory.ts`). Tout nouveau panel doit s'implémenter derrière
  cette abstraction, sans fuite côté client.

## 5. Installation de la plateforme — deux voies à fournir (les deux)
   a. **Interface web d'installation** : demande « host / user / password » PostgreSQL et configure
      automatiquement la base de la plateforme.
   b. **Installation sur serveur vierge en une commande** (curl/git/autre) qui rend ensuite l'interface
      web d'installation (a) accessible pour terminer la configuration.
   (Réf. interne : ADR à venir sur l'installeur ; l'installation et le bootstrap de la base ne doivent
   pas dépendre du réseau/du panel des apps clients.)

## 6. Règle d'exploitation dérivée (neutre vis-à-vis de l'abstraction)
Les opérations de déploiement/redéploiement d'apps passent **par l'API du panneau via le chemin de
code de la plateforme** (`PanelTransport.deployApp` / `createGitApp` / `applyAppLimits`…), **jamais**
par l'interface web du panneau ni par des commandes Docker « à la main ». Coolify reste invisible.
Voir aussi la mémoire [[architecture]].

### Rappel — avant toute mise en prod réelle (fin de projet)
Le **test d'installation réelle de la plateforme** (déployer LA plateforme comme une app packagée,
migrations hors contexte local, env de prod) est **volontairement repoussé à la fin du
développement**. N'exécuter ce déploiement de bout en bout **qu'en fin de projet**, avec la checklist
de la mémoire [[architecture]] : ① projet Coolify isolé / VPS dédié **séparé** des apps clients ;
② base Postgres **neuve** pour la plateforme (jamais les bases clientes) ; ③ déployer via son propre
chemin de code API puis valider démarrage+migrations+santé ; ④ **ensuite seulement** tester
l'installateur web (PG host/user/password) et la commande serveur-vierge (pas encore développés).