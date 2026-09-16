import type { ProductAdmin } from '@/lib/api';

/**
 * Logique pure de la Roadmap produit (readiness) — sans React, pour être
 * unit-testable isolément.
 *
 * Source de vérité serveur : la relation `pack → deploymentModule → server`
 * embarquée par le backend dans la payload admin du PRODUIT (`PRODUCT_INCLUDE`),
 * soit EXACTEMENT la représentation que le provisioning résout aussi
 * (`order.product.pack.deploymentModule.server`, cf. getProvisioning). On ne lit
 * donc PAS ici un scalaire `deploymentModuleId` (absent de la payload) ni une
 * liste de modules tierce : la readiness affiche le serveur réellement utilisé.
 *
 * Règle NOT_APPLICABLE (phase 2) : un produit SANS pack n'a pas de chemin de
 * déploiement lié — la section « Déploiement » devient informative au lieu de
 * cumuler de faux BLOCKING serveur. Un produit AVEC pack mais sans module ou sans
 * serveur, lui, garde un vrai BLOCKING (il est configuré pour héberger, l'absence
 * de serveur bloque réellement la création d'app).
 */

export type RoadmapTabKey =
  | 'general'
  | 'vitrine'
  | 'public'
  | 'boutique'
  | 'categories'
  | 'options'
  | 'addons'
  | 'subdomain'
  | 'provisioning';

export type Level = 'ok' | 'warn' | 'error' | 'info';

export interface RoadmapItem {
  status: Level;
  label: string;
  hint?: string;
  tab?: RoadmapTabKey;
}

export interface RoadmapSection {
  section: string;
  items: RoadmapItem[];
}

/** Recette de déploiement static validée live (voir mémoire static-spa-vite-fix) :
 *  nixpacks + isStatic + publish_directory:/dist — jamais buildPack « static ». */
const DEFAULT_STATIC_DIR = '/dist';

export function buildRoadmap(product: ProductAdmin): RoadmapSection[] {
  const mp = product.moduleParams ?? {};
  const repoUrl = (mp.repoUrl ?? '').trim();
  const branch = (mp.branch ?? '').trim();
  const buildPack = (mp.buildPack ?? '').trim();
  const publishDir = (mp.publishDirectory ?? '').trim();
  const isStatic = !!mp.isStatic;
  const appName = (mp.appName ?? '').trim();
  const freePlan = !!product.freePlan;
  const domainRequired = !!product.domainRequired;

  // ── Module / serveur de déploiement : relation réelle du pack ────────────
  // Le provisioning lit `order.product.pack.deploymentModule.server` (backend).
  // La payload admin du produit embarque la même relation (`pack.deploymentModule
  // { id, code, name, kind, server { id, hostname } }`). On consomme donc la
  // représentation backend déjà disponible — PAS un scalaire `deploymentModuleId`
  // (absent de la payload) ni un cross-lookup dans une liste de modules tierce.
  const deploymentModule = product.pack?.deploymentModule ?? null;
  const serverHostname = deploymentModule?.server?.hostname ?? null;
  const serveName = deploymentModule?.name ?? null;
  const isPerClient = deploymentModule?.kind === 'PER_CLIENT_PROJECT';

  // Un produit sans pack n'a pas de chemin d'hébergement : la validation serveur
  // est NOT_APPLICABLE, pas BLOCKING (sinon on imposerait artificiellement un
  // serveur à un produit qui n'en emploierait pas — la nudge « choisir un pack »
  // reste portée par la section Pack & classification).
  const deployable = !!product.pack;

  const deployItems: RoadmapItem[] = deployable
    ? [
        serveName
          ? { status: 'ok', label: `Module de déploiement : ${serveName}`, hint: `${isPerClient ? 'B · projet client dédié — une app par client sur Coolify.' : 'A · projet partagé — app configurée dans un projet commun.'}`, tab: 'general' }
          : { status: 'error', label: 'Aucun module de déploiement sur le pack', hint: 'Sans module (→ serveur Coolify), aucune app ne sera créée.', tab: 'general' },
        serverHostname
          ? { status: 'ok', label: 'Serveur Coolify configuré', hint: serverHostname }
          : { status: 'error', label: 'Serveur Coolify non configuré', hint: 'L’app ne peut pas être créée sans serveur sur le module.', tab: 'provisioning' },
        isPerClient
          ? { status: 'ok', label: 'Module type B', hint: 'Matching « Plan Gratuit » : une app dédiée par client.' }
          : { status: 'info', label: 'Module type A (projet partagé)', hint: 'App créée dans un projet commun — à réserver aux cas adaptés.' },
        repoUrl
          ? { status: 'ok', label: `Repo Git : ${repoUrl}`, tab: 'boutique' }
          : { status: 'error', label: 'repoUrl absent', hint: 'Indispensable : c’est lui qui déclenche la création de l’app sur Coolify.', tab: 'boutique' },
        branch !== ''
          ? { status: 'ok', label: `Branche : ${branch}`, tab: 'boutique' }
          : { status: 'warn', label: 'Branche vide', hint: 'Va prendre « main » par défaut. Vérifiez que c’est la bonne.', tab: 'boutique' },
        buildPack
          ? buildPack.toLowerCase() === 'static'
            ? { status: 'error', label: `Build pack « ${buildPack} » — casserait le build`, hint: `Le stack « static » de Coolify ne build PAS (page vide). Recette qui marche : ${DEFAULT_STATIC_DIR ? 'nixpacks' : 'nixpacks'} + cocher « Publier en statique » + publishDirectory ${DEFAULT_STATIC_DIR}.`, tab: 'boutique' }
            : { status: 'ok', label: `Build pack : ${buildPack}`, hint: isStatic ? 'Le build (nixpacks) est ensuite servi en statique — combinaison validée.' : 'Nixpacks/autre — sert un serveur applicatif.', tab: 'boutique' }
          : { status: 'warn', label: 'Build pack vide', hint: 'Prend « nixpacks » par défaut.', tab: 'boutique' },
        // ★ Le cœur du bug « Deploy my GitHub App » : cocher « Publier en statique »
        // requiert un répertoire de publication au format exigé par Coolify.
        isStatic ? (
          !publishDir
            ? { status: 'error', label: `« Publier en statique » coché mais dossier de publication vide`, hint: `Sans publishDirectory, l’app ne sera pas servie (vide). Mettez ${DEFAULT_STATIC_DIR} pour une SPA Vite.`, tab: 'boutique' }
            : !publishDir.startsWith('/')
              ? { status: 'error', label: `Répertoire « ${publishDir} » invalide`, hint: `Coolify exige un slash de tête (422) : utilisez « /${publishDir.replace(/^\/+/, '')} », par ex. ${DEFAULT_STATIC_DIR}.`, tab: 'boutique' }
              : { status: 'ok', label: `Répertoire de publication : ${publishDir}`, hint: 'Appelé à être servie en statique après le build nixpacks.', tab: 'boutique' }
        ) : publishDir ? (
          { status: 'warn', label: `publishDirectory défini (${publishDir}) mais « Publier en statique » non coché`, hint: 'Cohérence : un répertoire de publication sert surtout un build statique servi tel quel.', tab: 'boutique' }
        ) : (
          { status: 'ok', label: 'Publish directory : non requis (build non statique).' }
        ),
        isStatic
          ? { status: 'ok', label: '« Publier en statique » coché — sortie de build servie en static (nginx).', tab: 'boutique' }
          : { status: 'info', label: '« Publier en statique » non coché', hint: 'Activez-le pour qu’un site static généré (Vite) soit servi.', tab: 'boutique' },
        !appName
          ? { status: 'warn', label: 'Nom d’app (appName) vide', hint: 'Prendra le nom du produit. Un nom propre évite les ambiguïtés.', tab: 'boutique' }
          : { status: 'ok', label: `Nom d’app : ${appName}`, tab: 'boutique' },
        domainRequired
          ? { status: 'info', label: 'Sous-domaine requis à la commande', hint: 'Le sous-domaine client doit être choisi/attribué avant le déploiement.', tab: 'subdomain' }
          : { status: 'info', label: 'Aucun sous-domaine imposé — sous-domaine auto basé sur le slug.' },
      ]
    : [
        { status: 'info', label: 'Aucun pack — déploiement non applicable', hint: 'Choisissez un pack à l’onglet Général pour lier un module et un serveur.', tab: 'general' },
      ];

  return [
    {
      section: 'Identité & vitrine',
      items: [
        { status: 'ok', label: `Nom du produit : « ${product.name} »`, tab: 'general' },
        product.slug && product.slug.trim()
          ? { status: 'ok', label: `Slug public : « ${product.slug} »`, tab: 'vitrine' }
          : { status: 'warn', label: 'Slug public vide', hint: 'Définissez le slug dans l’onglet Vitrine pour générer les liens publics.', tab: 'vitrine' },
        product.status === 'ACTIVE'
          ? { status: 'ok', label: 'Statut ACTIVE — visible dans le catalogue et /shop.', tab: 'general' }
          : { status: 'warn', label: `Statut « ${product.status} » — non visible du public.`, hint: 'Passez à ACTIVE une fois la configuration validée pour publier.', tab: 'general' },
      ],
    },
    {
      section: 'Pack & classification',
      items: [
        product.pack
          ? { status: 'ok', label: `Pack lié : « ${product.pack.name} » (${product.pack.ramMb} Mo · ${product.pack.cpuCores} CPU${product.pack.freeSubdomainsIncluded ? ` · ${product.pack.freeSubdomainsIncluded} sous-dom. gratuits` : ''}).`, tab: 'general' }
          : { status: 'error', label: 'Aucun pack sélectionné', hint: 'Le pack porte le module et le serveur qui créeront l’app. Choisissez-le à l’onglet Général.', tab: 'general' },
        product.category
          ? { status: 'ok', label: `Catégorie : « ${product.category.name} ».`, tab: 'categories' }
          : { status: 'info', label: 'Aucune catégorie', hint: 'Facultatif, recommandé pour classer le catalogue.', tab: 'categories' },
        freePlan
          ? { status: 'info', label: 'Plan Gratuit — inscription sans panier ni facture.' }
          : { status: 'info', label: 'Produit payant — achat via le panier / checkout.' },
      ],
    },
    {
      section: 'Déploiement de l’app client',
      items: deployItems,
    },
  ];
}