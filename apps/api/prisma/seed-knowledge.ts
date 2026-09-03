// Phase 11 (ADR-028) — Seed initial de la base de connaissance.
//
// Stratégie (contractuelle) :
//   - Fichier SÉPARÉ de seed.ts (bootstrap admin) : la base de connaissance est
//     un contenu éditable — on ne veut JAMAIS l'écraser sur un simple `db:seed`.
//   - Idempotent par `[audience, slug]` : CRÉE si absent, NE MODIFIE JAMAIS un
//     article existant (les modifications admin ont priorité sur le seed).
//   - Contenu « sans invention » : les articles ADMIN sont rédigés à partir des
//     faits réels du dépôt (CHANGELOG.md, DECISIONS.md, architecture du code) ;
//     les articles CLIENT décrivent les fonctions réellement disponibles.
//   - Auteur : l'admin le plus ancien s'il existe, sinon auteur dénormalisé seed.
//
// Usage : `corepack pnpm --filter @icode-host-pro/api db:seed:knowledge`
// (nécessite la DB docker `icode-postgres` démarrée, comme db:seed).

import 'dotenv/config';
import { PrismaClient, KnowledgeAudience, KnowledgeStatus, KnowledgeType, Role } from '@prisma/client';

const prisma = new PrismaClient();

interface Article {
  audience: KnowledgeAudience;
  type: KnowledgeType;
  title: string;
  slug: string;
  summary: string;
  body: string; // HTML simple — sanitized côté /aide
  category?: string; // CLIENT : catégorie d'aide ; ADMIN : domaine
  phase?: string; // ADMIN : ex. "Phase 10"
  tags: string[];
}

const p = (html: string) => `<p>${html}</p>`;
const ul = (items: string[]) => `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
const h2 = (t: string) => `<h2>${t}</h2>`;
const code = (t: string) => `<code>${t}</code>`;

// ── Base ADMIN (interne) ─────────────────────────────────────────────────────
const ADMIN_ARTICLES: Article[] = [
  // ── INFORMATIVE : récapitulatif par phase ──────────────────────────────
  {
    audience: 'ADMIN',
    type: 'INFORMATIVE',
    phase: 'Phase 1',
    title: 'Phase 1 — Comptes & authentification (ADR-015/016)',
    slug: 'phase-1-authentification',
    summary:
      'Premières tables métier (User, RefreshToken) et authentification JWT avec rotation des refresh tokens.',
    body:
      h2('Ce qui a été fait') +
      p(
        'Socle d’authentification complet : comptes avec email unique, mot de passe haché (bcrypt), JWT d’accès court et refresh tokens stockés hachés avec rotation et révocation.',
      ) +
      h2('Décisions') +
      ul(['ADR-015 — approche d’authentification (JWT + refresh rotation)', 'ADR-016 — modèle de données Phase 1 (User, RefreshToken)']) +
      h2('Endpoints') +
      ul([
        'POST /auth/login · POST /auth/refresh · POST /auth/logout',
        'GET /users/me — profil du compte connecté',
      ]),
    tags: ['authentification', 'jwt', 'phase-1'],
  },
  {
    audience: 'ADMIN',
    type: 'INFORMATIVE',
    phase: 'Phase 2',
    title: 'Phase 2 — Modèle cœur : Produits & Serveurs (ADR-017)',
    slug: 'phase-2-modele-coeur',
    summary:
      'Les tables globales Product (catalogue) et Server (infrastructure) avec leurs statuts, gérées par l’admin.',
    body:
      h2('Ce qui a été fait') +
      p(
        'Création des deux tables cœur de la plateforme, globales (non rattachées à un client) : le catalogue de produits et l’inventaire des serveurs, chacun avec un cycle de statuts.',
      ) +
      h2('Modèle') +
      ul([
        `Product : nom unique, type (kind), statut ${code('DRAFT/ACTIVE/SUSPENDED/DISABLED')}`,
        `Server : nom unique, hostname, statut ${code('OFFLINE/ONLINE/PROBLEM/MAINTENANCE')}`,
      ]) +
      h2('Note Phase 11') +
      p(
        'Les produits n’ont pas de prix ni d’ordre d’affichage (pas de facturation à ce stade). Pour retirer un produit du catalogue, passez-le en DISABLED.',
      ),
    tags: ['catalogue', 'produits', 'serveurs', 'phase-2'],
  },
  {
    audience: 'ADMIN',
    type: 'INFORMATIVE',
    phase: 'Phase 3',
    title: 'Phase 3 — Console d’administration (ADR-018)',
    slug: 'phase-3-console-admin',
    summary:
      'Console /manager : gestion des comptes (promotion/rétrogradation, activation) avec gardes anti-verrouillage, et tableau de bord.',
    body:
      h2('Ce qui a été fait') +
      p(
        'Première console d’administration : liste des utilisateurs avec changement de rôle (ADMIN↔USER) et activation/désactivation, plus un tableau de bord de compteurs (produits, serveurs, utilisateurs par rôle/statut).',
      ) +
      h2('Gardes anti-verrouillage') +
      ul([
        'Impossible de changer son propre rôle.',
        'Impossible de rétrograder ou désactiver le dernier ADMIN actif.',
      ]),
    tags: ['admin', 'comptes', 'roles', 'phase-3'],
  },
  {
    audience: 'ADMIN',
    type: 'INFORMATIVE',
    phase: 'Phase 4',
    title: 'Phase 4 — Journal d’audit (ADR-019)',
    slug: 'phase-4-journal-audit',
    summary:
      'Journal d’audit de toutes les mutations, consultable dans /manager/journal avec filtres et pagination.',
    body:
      h2('Ce qui a été fait') +
      p(
        'Table AuditLog : chaque mutation sensible enregistre l’acteur (id + email dénormalisé), l’action, la ressource et des détails JSON, avec horodatage.',
      ) +
      h2('Particularités') +
      ul([
        'actorId en SetNull à la suppression du compte — le journal survit.',
        'Index sur createdAt / resourceType / action pour la consultation.',
      ]),
    tags: ['audit', 'journal', 'phase-4'],
  },
  {
    audience: 'ADMIN',
    type: 'INFORMATIVE',
    phase: 'Phase 5',
    title: 'Phase 5 — Invitations, Souscriptions & Services (ADR-020/021)',
    slug: 'phase-5-invitations-services',
    summary:
      'Inscription fermée + invitations par lien, workflow souscription (demande → approbation) et demande de service hébergé.',
    body:
      h2('Ce qui a été fait') +
      p(
        'L’inscription libre est fermée : un client est invité par un lien signé (ADR-020). L’espace client permet de souscrire à une offre (statut PENDING jusqu’à l’approbation admin) puis de demander un service sur une souscription active (ADR-021).',
      ) +
      h2('Parcours typique') +
      ul([
        'Invitation par email → acceptation → connexion',
        'Souscrire à une offre → approbation par l’admin (Approuver/Rejeter)',
        'Demander un service → affecter un serveur → ACTIVE (provisionnement stub)',
      ]) +
      h2('Note Phase 11') +
      p(
        'Depuis la Phase 10, un client peut aussi créer son compte au moment d’une commande (Google, GitHub ou email+mot de passe) — voir l’article « Parcours public de commande ».',
      ),
    tags: ['invitations', 'souscriptions', 'services', 'phase-5'],
  },
  {
    audience: 'ADMIN',
    type: 'INFORMATIVE',
    phase: 'Phase 6',
    title: 'Phase 6 — Configuration mail & chiffrement (ADR-022)',
    slug: 'phase-6-mail-chiffrement',
    summary:
      'Envoi d’emails transactionnels (SMTP/Brevo) via un singleton MailSetting, et chiffrement AES-256-GCM au repos des secrets.',
    body:
      h2('Ce qui a été fait') +
      p(
        'Un singleton MailSetting (hôte, port, STARTTLS/TLS, identifiants chiffrés, expéditeur) pilote l’envoi d’emails (invitations, codes support, OTP). Les identifiants sont chiffrés au repos via CryptoService (AES-256-GCM, clé dérivée de ENCRYPTION_KEY).',
      ) +
      h2('Points de vigilance (validation Brevo)') +
      ul([
        'Brevo exige l’autorisation de l’adresse IP sortante (code 525).',
        'Un expéditeur non validé est rejeté de façon asynchrone — vérifier Brevo → Logs → SMTP.',
      ]),
    tags: ['mail', 'brevo', 'smtp', 'chiffrement', 'phase-6'],
  },
  {
    audience: 'ADMIN',
    type: 'INFORMATIVE',
    phase: 'Phase 7',
    title: 'Phase 7 — Design system de l’interface (ADR-023)',
    slug: 'phase-7-design-system',
    summary:
      'Design system complet (tokens --brand-*, composants UI, anti-FOUC) : toute nouvelle page doit respecter ces règles.',
    body:
      h2('Ce qui a été fait') +
      p(
        'Un design system documenté (docs/design/DESIGN_SYSTEM.md) : palette via tokens CSS, composants réutilisables (Panel, Button, Badge, Field…), layout 1320px pour l’admin, thèmes clair/sombre.',
      ) +
      h2('Règle impérative') +
      p(
        'La charte est validée par le propriétaire et ne doit pas être modifiée sans demande explicite. Toute nouvelle page utilise les composants et tokens existants — jamais de rebrand.',
      ),
    tags: ['design', 'ui', 'charte', 'phase-7'],
  },
  {
    audience: 'ADMIN',
    type: 'INFORMATIVE',
    phase: 'Phase 7ter',
    title: 'Phase 7ter — Détails infrastructure Serveurs (ADR-024)',
    slug: 'phase-7ter-admin-serveurs',
    summary:
      'Pages admin larges : CRUD serveurs et produits avec champs infrastructure (IP, port, région, quota, fournisseur de panneau).',
    body:
      h2('Ce qui a été fait') +
      p(
        'Fiches serveurs enrichies : IP, port, région, quota, strictTLS, fournisseur de panneau (Hestia/Coolify) et credentials. Les pages admin passent en layout large (1320px).',
      ) +
      h2('Évolutivité') +
      p(
        'La fiche serveur est volontairement « évolutive » : elle s’enrichira automatiquement (statut, charge, observations panel) via la sonde de connectivité (ADR-025) et les adaptateurs réels (ADR-010). Le provisionnement reste un stub (ADR-021).',
      ),
    tags: ['serveurs', 'infrastructure', 'phase-7ter'],
  },
  {
    audience: 'ADMIN',
    type: 'INFORMATIVE',
    phase: 'Phase 8',
    title: 'Phase 8 — Sonde de connectivité serveurs (ADR-025)',
    slug: 'phase-8-sonde-connectivite',
    summary:
      'Premier pas réel vers les connecteurs : la page serveurs vérifie TCP + HTTP (réel, pas simulé) et affiche le statut de chaque serveur.',
    body:
      h2('Ce qui a été fait') +
      p(
        'Une sonde de connectivité (TCP + HTTP) interroge chaque serveur à la demande et affiche un statut réel (joignable, web servi, erreurs réseau traduites en français). Le statut est rafraîchi manuellement (pas encore de sonde périodique — ADR-007 reste PROPOSED).',
      ) +
      h2('À venir (hors périmètre)') +
      ul([
        'Politique automatique des statuts par sonde périodique (ADR-007).',
        'Adaptateurs fournisseurs réels + credentials (ADR-010 complet).',
        'cPanel / DirectAdmin.',
      ]),
    tags: ['sonde', 'connectivité', 'phase-8'],
  },
  {
    audience: 'ADMIN',
    type: 'INFORMATIVE',
    phase: 'Phase 9',
    title: 'Phase 9 — Adaptateurs fournisseurs réels Hestia/Coolify (ADR-010)',
    slug: 'phase-9-adaptateurs-panel',
    summary:
      'Connexion réelle aux panneaux Hestia et Coolify (version API + vérification), credentials chiffrés, auto-détection IP/port.',
    body:
      h2('Ce qui a été fait') +
      p(
        'Adaptateurs réels via panelProvider : Coolify (Bearer, GET /version) et Hestia (Basic, commande sysinfo). La page serveurs vérifie l’API avec les credentials fournis (clés chiffrées au repos) et affiche la version du panneau. Auto-détection IP/port (ADR-026, Phase 9bis) + accès direct « Ouvrir » + métriques RAM/CPU/disque/bande passante.',
      ),
    tags: ['hestia', 'coolify', 'panneaux', 'adaptateurs', 'phase-9'],
  },
  {
    audience: 'ADMIN',
    type: 'INFORMATIVE',
    phase: 'Phase 10',
    title: 'Phase 10 — Sécurité, comptes & support (ADR-027)',
    slug: 'phase-10-securite-comptes-support',
    summary:
      'Turnstile, OAuth Google/GitHub, MFA (TOTP + email), impersonation, rôles support L1/L2/L3, code d’accès support, tickets.',
    body:
      h2('Ce qui a été fait') +
      p(
        'Refonte « security-first » : chaque option de sécurité est un feature-flag piloté par l’admin (page /manager/securite) et reste non obligatoire. Détails dans l’article technique « Sécurité applicative ».',
      ) +
      h2('Résumé') +
      ul([
        'Anti-bot Turnstile (Cloudflare) sur le login.',
        'Connexion Google / GitHub — activables par l’admin.',
        'MFA double méthode (TOTP appli + code email) — self-service.',
        'Impersonation « Se connecter en tant que client » (session courte, auditée, rôle forcé USER).',
        'Rôles support L1/L2/L3 avec code 6 chiffres pour l’accès lecture seule.',
        'Tickets de support minimal (ouverture, réponses, escalade).',
        'Inscription fermée sauf « à la commande » (parcours public).',
      ]),
    tags: ['securite', 'mfa', 'oauth', 'impersonation', 'support', 'phase-10'],
  },
  {
    audience: 'ADMIN',
    type: 'INFORMATIVE',
    phase: 'Phase 11',
    title: 'Phase 11 — Base de connaissance & clés Turnstile (ADR-028)',
    slug: 'phase-11-connaissance-turnstile',
    summary:
      'Deux bases de connaissance (interne admin + centre d’aide client) et gestion des clés Turnstile depuis l’admin.',
    body:
      h2('Ce qui a été fait') +
      p(
        'Un module KnowledgeArticle unique avec deux audiences : les articles internes ADMIN (récaps de phase, technique, guides) et le catalogue CLIENT publié sur /aide. L’admin gère tout depuis /manager/connaissance. Les clés Turnstile (site publique + secret chiffré) sont désormais saisies et modifiables depuis /manager/securite.',
      ) +
      h2('Séparation stricte') +
      ul([
        'Le client ne voit JAMAIS un article interne admin ni un brouillon.',
        'Le centre d’aide /aide est public (SEO) — seuls les articles CLIENT + PUBLISHED y sont servis.',
      ]),
    tags: ['connaissance', 'aide', 'turnstile', 'phase-11'],
  },

  // ── TECHNICAL : architecture & sécurité ────────────────────────────────
  {
    audience: 'ADMIN',
    type: 'TECHNICAL',
    title: 'Architecture du monorepo',
    slug: 'architecture-monorepo',
    summary:
      'Monorepo Turborepo + pnpm : API NestJS 11 (apps/api), front Next.js 15 (apps/web), PostgreSQL/Prisma, gouvernance ADR.',
    body:
      h2('Structure') +
      ul([
        `${code('apps/api')} — NestJS 11, modules par domaine (auth, users, products, servers, subscriptions, invitations, mail, audit, tickets, support, knowledge, deployments).`,
        `${code('apps/web')} — Next.js 15 App Router, pages sous ${code('src/app')}, lib API + session, composants UI du design system.`,
        `${code('apps/api/prisma')} — schéma + migrations ; seed.ts (admin) et seed-knowledge.ts (base de connaissance).`,
        `${code('docs/')} — design system, guides, commandes SQL.`,
        `Gouvernance : TASKS.md, DECISIONS.md (ADR), CHANGELOG.md, PROJECT_STATUS.md, HANDOVER.md.`,
      ]) +
      h2('Points d’attention') +
      ul([
        'Config via ConfigModule (chargée par config/configuration.ts, échec au boot si valeurs requises manquantes).',
        'DB : PostgreSQL dans Docker (icode-postgres), Prisma en ORM, migrations versionnées.',
        'Chaque étape est vérifiée : unit → e2e → tsc → build (dev arrêté + .next purgé avant build).',
      ]),
    tags: ['architecture', 'monorepo', 'nestjs', 'nextjs', 'prisma'],
  },
  {
    audience: 'ADMIN',
    type: 'TECHNICAL',
    title: 'Rôles & permissions (hiérarchie, RolesGuard)',
    slug: 'permissions-roles',
    summary:
      'Hiérarchie linéaire USER < SUPPORT_L1 < SUPPORT_L2 < SUPPORT_L3 < ADMIN, source unique dans auth/roles.ts (ROLE_RANK).',
    body:
      h2('Rang des rôles') +
      p(
        `${code('ROLE_RANK')} = { USER:0, SUPPORT_L1:1, SUPPORT_L2:2, SUPPORT_L3:3, ADMIN:99 }. Le RolesGuard accepte tout rôle dont le rang est ≥ à celui exigé par la route : @Roles(ADMIN) n’est satisfait que par ADMIN ; @Roles(SUPPORT_L1) par L1/L2/L3/ADMIN.`,
      ) +
      h2('Règles de non-escalade') +
      ul([
        'Un jeton d’impersonation a toujours role USER à la signature → ne passe aucun rôle support/admin, même si la cible est promue ensuite.',
        'Chaque mutation est auditée (audit.*).',
        'Le support L2 n’accède à l’espace client qu’en lecture seule, via un code 6 chiffres généré par le client.',
      ]),
    tags: ['roles', 'permissions', 'guard', 'securite'],
  },
  {
    audience: 'ADMIN',
    type: 'TECHNICAL',
    title: 'Sécurité applicative (chiffrement, rate limiting, Turnstile, MFA, impersonation)',
    slug: 'securite-applicative',
    summary:
      'CryptoService AES-256-GCM, rate limiter maison, Turnstile, MFA TOTP+email, impersonation courte et auditée, code support verrouillé.',
    body:
      h2('Chiffrement au repos') +
      p(
        `${code('CryptoService')} : AES-256-GCM, clé = sha256(ENCRYPTION_KEY), payload ${code('iv||tag||data')} base64. Utilisé pour les mots de passe mail, les credentials panel, la clé secrète Turnstile, les secrets MFA et les tokens GitHub. Les secrets ne sont jamais renvoyés par l’API.`,
      ) +
      h2('Rate limiting') +
      p(
        'Rate limiter maison (fenêtre glissante en mémoire, par IP, zéro dépendance, 429) sur login, MFA (verify + email/send), register, checkout intent et accès support.',
      ) +
      h2('Turnstile') +
      p(
        'Anti-bot Cloudflare appliqué sur login et accès support quand le flag admin est activé ET la clé secrète présente. La clé site (publique) est exposée par GET /api/public/auth-config.',
      ) +
      h2('MFA') +
      p(
        'Deux méthodes : TOTP (otplib, step 30s) et email OTP. Challenge single-use 300 s, 5 essais max, throttle IP. Self-service par utilisateur ; l’admin peut rendre le MFA obligatoire pour les admins.',
      ) +
      h2('Impersonation') +
      p(
        'Session courte (60 min, cap 24 h), sans refresh token ni cookie → aucune prolongation. Rôle USER forcé à la signature, bandeau web, fin auditée (impersonate.end).',
      ) +
      h2('Code d’accès support') +
      p(
        'Code 6 chiffres stocké en HMAC-SHA256 (pepper), TTL 60 min (clamp 5–1440), un seul actif, affiché une fois, verrouillé après 5 échecs.',
      ),
    tags: ['chiffrement', 'ratelimit', 'turnstile', 'mfa', 'impersonation'],
  },
  {
    audience: 'ADMIN',
    type: 'TECHNICAL',
    title: 'Connecteurs panneau : Hestia & Coolify (PanelTransport)',
    slug: 'transport-panels',
    summary:
      'Factory PanelTransport : contrat e2e-mockable pour Coolify (Bearer) et Hestia (Basic), vérification d’API, metrics serveur.',
    body:
      h2('Design') +
      p(
        `${code('PanelTransportFactory')} construit le transport selon ${code('panelProvider')} : Coolify (Bearer, base + /version) ou Hestia (Basic, user api, commande sysinfo). Timeout 8 s, erreurs réseau traduites en français. Un transport de test (ProbeTransport) est injecté en e2e.`,
      ) +
      h2('Capacités') +
      ul([
        'Vérification d’API : bouton « Vérifier l’API » sur la fiche serveur.',
        'Métriques : RAM, CPU, disque, bande passante (Phase 9bis).',
        'Prévu pour la Phase 10bis : création d’applications git et déploiement (createGitApp/deployApp).',
      ]),
    tags: ['hestia', 'coolify', 'panel', 'transport', 'api'],
  },

  // ── HOWTO : guides d’utilisation admin ─────────────────────────────────
  {
    audience: 'ADMIN',
    type: 'HOWTO',
    title: 'Configurer un serveur (création, API, sonde)',
    slug: 'howto-configurer-serveur',
    summary: 'Créer un serveur dans /manager/serveurs, choisir le fournisseur de panneau et vérifier la connexion API.',
    body:
      h2('Étapes') +
      ul([
        'Aller dans Administration → Serveurs → « Nouveau serveur ».',
        'Renseigner nom, hostname, IP/port (auto-détection possible), région, quota, et le fournisseur de panneau (Hestia ou Coolify) avec ses credentials.',
        'Option strictTLS à activer si le panneau sert un certificat de confiance.',
        'Utiliser « Vérifier l’API » pour confirmer la connexion (version du panneau affichée).',
        'La carte du serveur affiche le statut de connectivité (sonde TCP/HTTP) — bouton « Re-tester ».',
      ]),
    tags: ['serveurs', 'howto', 'config'],
  },
  {
    audience: 'ADMIN',
    type: 'HOWTO',
    title: 'Approuver une souscription et affecter un serveur',
    slug: 'howto-approuver-souscription',
    summary: 'Traiter les demandes client depuis Administration → Souscriptions & services.',
    body:
      h2('Souscription') +
      ul([
        'Dans « Souscriptions client », une demande PENDING se traite par Approuver (ACTIVE) ou Rejeter.',
        'Une souscription active peut être suspendue puis réactivée.',
      ]) +
      h2('Service') +
      ul([
        'Dans « Services demandés », choisir un serveur dans la liste, puis « Affecter & provisionner » (REQUESTED → PROVISIONING), puis « Activer » (PROVISIONING → ACTIVE).',
        'Le provisionnement est un stub : aucun déploiement réel n’est déclenché.',
      ]),
    tags: ['souscriptions', 'services', 'howto', 'approbation'],
  },
  {
    audience: 'ADMIN',
    type: 'HOWTO',
    title: 'Configurer l’envoi d’emails (SMTP / Brevo)',
    slug: 'howto-configurer-mail',
    summary: 'Renseigner le serveur SMTP (ex. Brevo) dans Administration → Configuration mail.',
    body:
      h2('Étapes') +
      ul([
        'Aller dans Administration → Configuration mail.',
        'Activer l’envoi, renseigner hôte, port (587 STARTTLS par défaut, 465 = TLS implicite), identifiant, mot de passe et l’expéditeur.',
        'Le mot de passe est chiffré au repos ; l’API ne renvoie que son état (présent ou non).',
      ]) +
      h2('Brevo — pièges connus') +
      ul([
        `Autoriser l’adresse IP sortante (erreur 525 sinon).`,
        `Expéditeur non validé → rejet asynchrone : vérifier Brevo → Logs → SMTP.`,
      ]),
    tags: ['mail', 'brevo', 'howto', 'smtp'],
  },
  {
    audience: 'ADMIN',
    type: 'HOWTO',
    title: 'Activer / désactiver les options de sécurité',
    slug: 'howto-options-securite',
    summary: 'Depuis Administration → Sécurité : Turnstile, OAuth, MFA obligatoire, inscription à la commande, déploiements.',
    body:
      h2('Page Sécurité (/manager/securite)') +
      ul([
        'Turnstile : coller la clé site (publique) et la clé secrète, puis activer le toggle. L’état « clé secrète présente » est affiché, jamais la clé.',
        'OAuth Google / GitHub : activer chaque fournisseur (les clés sont lues depuis les variables d’environnement).',
        'MFA obligatoire pour les admins : les admins sans MFA seront invités à l’activer à la connexion.',
        'Inscription à la commande : sans ce toggle, l’inscription reste fermée (403).',
        'Déploiements (Phase 10bis) : prépare l’activation du panneau Déploiements client.',
      ]) +
      p('Chaque modification est journalisée dans le journal d’audit.'),
    tags: ['securite', 'turnstile', 'oauth', 'howto', 'flags'],
  },
  {
    audience: 'ADMIN',
    type: 'HOWTO',
    title: 'Utiliser la base de connaissance',
    slug: 'howto-base-connaissance',
    summary: 'Créer, publier, archiver des articles internes admin ou pour le centre d’aide client.',
    body:
      h2('Principe') +
      p(
        'Deux onglets : « Admin (interne) » pour la documentation d’équipe, « Client (/aide) » pour le centre d’aide public. L’admin gère les deux depuis la même page.',
      ) +
      h2('Créer un article') +
      ul([
        '« Nouvel article » → choisir audience, type (Informatif / Technique / Guide), statut (Brouillon / Publié / Archivé).',
        'Le slug est auto-généré depuis le titre (modifiable).',
        'Le contenu est du HTML simple (titres, listes, code) — il est assaini côté /aide.',
        '« Publier » rend l’article visible : pour les articles client, sur le centre d’aide public.',
      ]) +
      h2('Convention') +
      ul([
        'Article Informative = récapitulatif d’une phase → renseigner le champ « Phase ».',
        'Guide = explication pas à pas d’une fonctionnalité.',
      ]),
    tags: ['connaissance', 'aide', 'howto', 'publication'],
  },
  {
    audience: 'ADMIN',
    type: 'HOWTO',
    title: 'Se connecter en tant que client (impersonation)',
    slug: 'howto-impersonation',
    summary: 'Accéder à l’espace client d’un compte USER en un clic, en session courte auditée.',
    body:
      h2('Étapes') +
      ul([
        'Administration → Utilisateurs → bouton « Se connecter en tant que » sur un compte USER.',
        'Un bandeau rouge apparaît en haut de l’espace client : « Vous consultez l’espace de <email> (admin) — Revenir ».',
        '« Revenir » termine la session d’impersonation et ramène à l’administration.',
      ]) +
      h2('Garanties') +
      ul([
        'Session courte (60 min), sans refresh : elle expire et ne se prolonge jamais.',
        'Le jeton force le rôle USER → aucune action admin possible pendant l’impersonation.',
        'Début et fin sont journalisés (impersonate.start / impersonate.end).',
      ]),
    tags: ['impersonation', 'howto', 'admin', 'utilisateurs'],
  },
  {
    audience: 'ADMIN',
    type: 'HOWTO',
    title: 'Traiter un ticket de support (L1/L2/L3) + code d’accès',
    slug: 'howto-tickets',
    summary: 'Répondre, escalader et clôturer les tickets clients ; accéder à l’espace client en lecture via le code 6 chiffres.',
    body:
      h2('Niveaux') +
      ul([
        `L1 — répond aux tickets (page Support), escalade vers L2/L3.`,
        `L2 — L1 + accès lecture seule à l’espace client via un code 6 chiffres généré par le client.`,
        `L3 — L1 + L2 + vues admin en lecture seule.`,
      ]) +
      h2('Accès lecture seule (L2/L3)') +
      ul([
        'Demander au client son code 6 chiffres (généré dans Espace client → Accès support).',
        'Le saisir dans la console support pour ouvrir l’espace client en lecture seule (bandeau bleu).',
        'Le code expire (60 min) et se verrouille après 5 échecs.',
      ]) +
      h2('Cycle de vie d’un ticket') +
      ul([
        'Ouvert → En cours → En attente client → Résolu → Fermé.',
        'L’escalade (L1 → L2/L3) est journalisée et visible du client.',
      ]),
    tags: ['tickets', 'support', 'howto', 'escalade', 'code'],
  },
];

// ── Base CLIENT (centre d’aide public /aide) ────────────────────────────────
const CLIENT_ARTICLES: Article[] = [
  {
    audience: 'CLIENT',
    type: 'INFORMATIVE',
    category: 'Premiers pas',
    title: 'Bienvenue dans votre espace client',
    slug: 'bienvenue-espace-client',
    summary: 'Ce que vous pouvez faire depuis votre espace client : commander, suivre vos services, ouvrir un ticket.',
    body:
      h2('Votre espace client vous permet de') +
      ul([
        'Parcourir le catalogue d’offres et commander.',
        'Suivre vos souscriptions et vos services (statuts à jour).',
        'Générer un code d’accès temporaire pour le support.',
        'Ouvrir et suivre des tickets.',
        'Gérer la sécurité de votre compte (MFA, fournisseurs liés, mot de passe).',
        'Consulter le centre d’aide.',
      ]) +
      p('Les serveurs et l’infrastructure ne sont jamais exposés côté client : tout est géré par l’administrateur.'),
    tags: ['bienvenue', 'espace-client'],
  },
  {
    audience: 'CLIENT',
    type: 'HOWTO',
    category: 'Premiers pas',
    title: 'Commander une offre et suivre ma souscription',
    slug: 'commander-une-offre',
    summary: 'Choisir une offre du catalogue, la commander, puis suivre l’approbation de l’administrateur.',
    body:
      h2('Étapes') +
      ul([
        'Depuis la page d’accueil, consulter les offres et cliquer sur « Commander ».',
        'Créer votre compte (Google, GitHub ou email + mot de passe) — la commande est liée à ce compte.',
        'Dans Espace client → Catalogue, votre souscription apparaît « En attente ».',
        'Une fois approuvée par l’administrateur, elle passe « Active ».',
      ]) +
      h2('Statuts possibles') +
      ul([
        'En attente — demande envoyée, en cours de validation.',
        'Active — offre en cours.',
        'Rejetée / Suspendue / Annulée — selon le cas.',
      ]),
    tags: ['commander', 'souscription', 'offres'],
  },
  {
    audience: 'CLIENT',
    type: 'HOWTO',
    category: 'Premiers pas',
    title: 'Demander un service hébergé',
    slug: 'demander-un-service',
    summary: 'Une fois une souscription active, demander un service (ex. un site web) et suivre sa mise en service.',
    body:
      h2('Étapes') +
      ul([
        'Avoir une souscription active.',
        'Dans Espace client → « Demander un service », saisir un nom de service et valider.',
        'L’administrateur affecte l’infrastructure ; le service passe « Actif » quand il est prêt.',
      ]) +
      p('Vous ne voyez jamais les serveurs : la mise en service est réalisée côté administrateur.'),
    tags: ['service', 'hebergement'],
  },
  {
    audience: 'CLIENT',
    type: 'HOWTO',
    category: 'Compte & sécurité',
    title: 'Créer son compte lors d’une commande',
    slug: 'creer-son-compte',
    summary: 'L’inscription libre est fermée : votre compte est créé au moment de passer commande, via Google, GitHub ou email.',
    body:
      h2('Comment créer un compte ?') +
      p(
        'L’inscription libre est volontairement fermée. Votre compte est créé lorsque vous passez une commande, en choisissant l’un de ces moyens :',
      ) +
      ul([
        'Google (connexion avec votre compte Google),',
        'GitHub (connexion avec votre compte GitHub),',
        'Email + mot de passe (formulaire de création).',
      ]) +
      h2('Après la commande') +
      p('La commande est enregistrée sur votre nouveau compte ; connectez-vous ensuite avec le même moyen pour la suivre dans l’espace client.'),
    tags: ['compte', 'inscription', 'commande', 'oauth'],
  },
  {
    audience: 'CLIENT',
    type: 'HOWTO',
    category: 'Compte & sécurité',
    title: 'Activer la double authentification (MFA)',
    slug: 'double-authentification-mfa',
    summary: 'Renforcer votre compte avec un code à usage unique : via une application d’authentification (TOTP) ou par email.',
    body:
      h2('Depuis Mon profil → Sécurité') +
      ul([
        'Application d’authentification : scanner le QR code, puis saisir le code à 6 chiffres pour confirmer.',
        'Code par email : un code à usage unique vous est envoyé à chaque connexion.',
      ]) +
      h2('À chaque connexion') +
      p(
        'Après votre mot de passe (ou votre fournisseur Google/GitHub), un second code vous sera demandé. Vous pouvez désactiver le MFA à tout moment depuis Mon profil (mot de passe + code requis).',
      ) +
      p('Si l’administrateur a rendu le MFA obligatoire pour les admins, cette règle ne s’applique qu’aux administrateurs, pas aux clients.'),
    tags: ['mfa', 'securite', 'totp', 'double-authentification'],
  },
  {
    audience: 'CLIENT',
    type: 'HOWTO',
    category: 'Compte & sécurité',
    title: 'Changer mon mot de passe',
    slug: 'changer-mot-de-passe',
    summary: 'Modifier le mot de passe de votre compte depuis Mon profil.',
    body:
      h2('Étapes') +
      ul([
        'Aller dans Mon profil.',
        'Dans la section mot de passe, saisir l’ancien mot de passe puis le nouveau.',
        'Valider — la modification est immédiate.',
      ]) +
      p('Conseil : utilisez un mot de passe long et unique, et activez la double authentification.'),
    tags: ['mot-de-passe', 'compte'],
  },
  {
    audience: 'CLIENT',
    type: 'HOWTO',
    category: 'Compte & sécurité',
    title: 'Lier mon compte Google ou GitHub',
    slug: 'lier-google-github',
    summary: 'Associer un fournisseur (Google/GitHub) à votre compte email+mot de passe pour vous connecter plus vite.',
    body:
      h2('Étapes') +
      ul([
        'Dans Mon profil → Fournisseurs liés, cliquer sur « Lier Google » ou « Lier GitHub ».',
        'Autoriser la connexion chez le fournisseur.',
        'Le fournisseur apparaît ensuite comme moyen de connexion à votre compte.',
      ]) +
      h2('Délier') +
      p('Vous pouvez retirer un fournisseur à tout moment. Tant qu’un moyen de connexion (email+mot de passe ou un fournisseur) reste actif, votre compte reste accessible.'),
    tags: ['oauth', 'google', 'github', 'liaison'],
  },
  {
    audience: 'CLIENT',
    type: 'INFORMATIVE',
    category: 'Compte & sécurité',
    title: 'Bonnes pratiques de sécurité',
    slug: 'securite-de-mon-compte',
    summary: 'Quelques réflexes simples pour protéger votre compte et vos services.',
    body:
      h2('Les bons réflexes') +
      ul([
        'Activer la double authentification (MFA).',
        'Utiliser un mot de passe unique et ne jamais le partager.',
        'Vérifier que l’adresse email du compte est bien la vôtre (elle sert aux codes et aux notifications).',
        'Ne communiquer le code d’accès support que par téléphone, à un agent qui vous l’a demandé.',
      ]) +
      h2('Le code d’accès support') +
      p(
        'Le code à 6 chiffres donne accès à votre espace EN LECTURE SEULE à un agent du support. Il expire automatiquement et se révoque d’un clic. Ne le partagez jamais ailleurs que par téléphone avec le support.',
      ),
    tags: ['securite', 'conseils', 'code-support'],
  },
  {
    audience: 'CLIENT',
    type: 'HOWTO',
    category: 'Support',
    title: 'Ouvrir et suivre un ticket de support',
    slug: 'ouvrir-un-ticket',
    summary: 'Décrire votre problème, suivre les réponses du support et la progression de votre ticket.',
    body:
      h2('Étapes') +
      ul([
        'Dans Espace client → « Mes tickets », saisir un sujet et une description.',
        'Le support (niveau L1) vous répond ; si besoin, le ticket est escaladé vers un niveau supérieur.',
        'Vous pouvez ajouter des messages à tout moment.',
      ]) +
      h2('Statuts') +
      ul([
        'Ouvert → En cours → En attente client → Résolu → Fermé.',
        'L’escalade éventuelle est affichée sur le ticket.',
      ]),
    tags: ['ticket', 'support', 'aide'],
  },
  {
    audience: 'CLIENT',
    type: 'HOWTO',
    category: 'Support',
    title: 'Donner un accès temporaire au support (code 6 chiffres)',
    slug: 'code-acces-support',
    summary: 'Permettre à un agent du support de consulter votre espace en lecture seule, sans lui donner votre mot de passe.',
    body:
      h2('Pourquoi ?') +
      p(
        'Si vous appelez le support pour un problème, un agent peut avoir besoin de voir votre espace (lecture seule). Le code évite de partager votre mot de passe.',
      ) +
      h2('Étapes') +
      ul([
        'Dans Espace client → « Accès support », cliquer sur « Générer un code ».',
        'Un code à 6 chiffres s’affiche UNE SEULE FOIS — transmettez-le par téléphone à l’agent.',
        'Le code expire automatiquement (60 minutes) et vous pouvez le révoquer à tout moment.',
      ]) +
      h2('Sécurité') +
      ul([
        'Accès en lecture seule uniquement : l’agent ne peut rien modifier.',
        'Après 5 saisies erronées, le code est verrouillé — générez-en un nouveau si besoin.',
      ]),
    tags: ['code-support', 'acces', 'lecture-seule'],
  },
  {
    audience: 'CLIENT',
    type: 'INFORMATIVE',
    category: 'Support',
    title: 'Le centre d’aide',
    slug: 'centre-daide',
    summary: 'Où trouver les guides et articles : tout est ici, sur /aide, avec recherche et catégories.',
    body:
      h2('Trouver une réponse') +
      ul([
        'Utilisez la barre de recherche en haut du centre d’aide.',
        'Filtrez par catégorie (Premiers pas, Compte & sécurité, Support).',
        'Ouvrez un article pour le lire en détail.',
      ]) +
      h2('Pas de réponse ?') +
      p('Ouvrez un ticket depuis votre espace client : le support vous répondra.'),
    tags: ['aide', 'recherche'],
  },
];

// ── Application (idempotent, création si absente) ───────────────────────────
async function main(): Promise<void> {
  const author = await prisma.user.findFirst({
    where: { role: Role.ADMIN },
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true },
  });

  let created = 0;
  let skipped = 0;

  for (const article of [...ADMIN_ARTICLES, ...CLIENT_ARTICLES]) {
    const exists = await prisma.knowledgeArticle.findFirst({
      where: { audience: article.audience, slug: article.slug },
      select: { id: true },
    });
    if (exists) {
      skipped += 1;
      continue;
    }
    await prisma.knowledgeArticle.create({
      data: {
        audience: article.audience,
        type: article.type,
        status: KnowledgeStatus.PUBLISHED,
        title: article.title,
        slug: article.slug,
        summary: article.summary,
        body: article.body,
        category: article.category ?? null,
        phase: article.phase ?? null,
        tags: article.tags,
        publishedAt: new Date(),
        authorId: author?.id ?? null,
        authorEmail: author?.email ?? 'seed@icode-host.local',
      },
    });
    created += 1;
  }

  console.log(
    `Knowledge seed: ${created} créé(s), ${skipped} existant(s) (non modifiés). ` +
      `Auteur: ${author?.email ?? 'seed@icode-host.local (aucun admin)'}.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
