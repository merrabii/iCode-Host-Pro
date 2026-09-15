'use client';

import type { DeploymentModule, PackAdmin, ProductAdmin } from '@/lib/api';
import { Badge } from '@/components/ui';

/**
 * Onglet « Roadmap » — tableau de bord de mise en configuration du produit.
 * Analyse l'état courant du produit (identité, vitrine, pack, déploiement) et
 * affiche une checklist pas-à-pas : ce qui est fait, ce qui manque, ce qui est
 * incorrect ou bloquant. Chaque ligne renvoie vers l'onglet à corriger,
 * pour ne pas se perdre dans les 9 onglets de l'éditeur.
 *
 * Cas emblématique couvert : un produit GitHub (buildPack "static") SANS
 * publishDirectory ni isStatic ne génère AUCUNE app servable sur Coolify —
 * exactement le bug constaté sur « Deploy my GitHub App » vs « Plan Gratuit ».
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

type Level = 'ok' | 'warn' | 'error' | 'info';
interface Item {
  status: Level;
  label: string;
  hint?: string;
  tab?: RoadmapTabKey;
}

const LEVEL_META: Record<Level, { icon: string; tone: string; title: string }> = {
  ok: { icon: '✔', tone: 'green', title: 'Fait' },
  warn: { icon: '⚠', tone: 'amber', title: 'À corriger / manquant' },
  error: { icon: '✖', tone: 'red', title: 'Bloquant' },
  info: { icon: 'ℹ', tone: 'blue', title: 'Info' },
};

/** Recette de déploiement static validée live (voir mémoire static-spa-vite-fix) :
 *  nixpacks + isStatic + publish_directory:/dist — jamais buildPack « static ». */
const DEFAULT_STATIC_DIR = '/dist';

function summarize(scored: Item[]): { ok: number; warn: number; error: number } {
  const s = { ok: 0, warn: 0, error: 0 };
  for (const it of scored) if (it.status === 'ok') s.ok++; else if (it.status === 'warn') s.warn++; else if (it.status === 'error') s.error++;
  return s;
}

function RoadmapRow({ item }: { item: Item }) {
  const m = LEVEL_META[item.status];
  return (
    <div className="row" style={{ gap: 10, padding: '7px 0', borderBottom: '1px solid var(--border-soft)', justifyContent: 'space-between', alignItems: 'flex-start' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', minWidth: 0 }}>
        <span
          style={{
            width: 20, height: 20, flex: '0 0 20px', borderRadius: 20,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 12, fontWeight: 700, marginTop: 1,
            color: '#fff', background: m.tone === 'green' ? 'var(--success)' : m.tone === 'amber' ? 'var(--warning)' : m.tone === 'red' ? 'var(--danger)' : 'var(--info)',
          }}
          title={m.title}
        >
          {m.icon}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, color: 'var(--text-primary)' }}>{item.label}</div>
          {item.hint && <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{item.hint}</div>}
        </div>
      </div>
      <Badge tone={m.tone === 'green' ? 'green' : m.tone === 'red' ? 'red' : 'amber'}>{m.title}</Badge>
    </div>
  );
}

/** Construit la checklist à partir des données déjà chargées (aucun fetch réseau). */
function buildRoadmap(
  product: ProductAdmin,
  modules: DeploymentModule[],
): { section: string; items: Item[] }[] {
  const mp = product.moduleParams ?? {};
  const repoUrl = (mp.repoUrl ?? '').trim();
  const branch = (mp.branch ?? '').trim();
  const buildPack = (mp.buildPack ?? '').trim();
  const publishDir = (mp.publishDirectory ?? '').trim();
  const isStatic = !!mp.isStatic;
  const appName = (mp.appName ?? '').trim();
  const freePlan = !!product.freePlan;
  const domainRequired = !!product.domainRequired;

  // Le module/serveur de déploiement RÉEL vient du PACK du produit
  // (Produit → Pack → Module → Serveur), exactement comme le provisioning
  // (order.product.pack.deploymentModule.server). On le résout donc via
  // `pack.deploymentModuleId` dans la liste `modules` (riche : kind + serveur).
  // ATTENTION : `provisionModuleId` est l'id d'une **ProvisionMethod** (actions
  // de provisioning), PAS un DeploymentModule — l'y chercher renvoyait toujours
  // `undefined` et affichait à tort « Serveur non configuré ».
  const packDeployModuleId = product.pack?.deploymentModuleId ?? null;
  const mod = packDeployModuleId
    ? (modules.find((m) => m.id === packDeployModuleId) ?? null)
    : null;
  const server = (mod as { server?: { hostname?: string | null } | null } | null)?.server;

  // Le pack référence aussi son module en vue partielle (id/code/nom, sans kind) ;
  // la résolution ci-dessus ajoute le type A/B et le serveur.
  const packModName = product.pack?.deploymentModule?.name ?? null;
  const serveName = mod?.name ?? packModName ?? null;
  const isPerClient = mod?.kind === 'PER_CLIENT_PROJECT';

  // La case « Publier en statique (nginx) » (isStatic) est LE vrai signal : elle
  // dit à Coolify de servir la sortie de build en static. `buildPack` reste le
  // stack de BUILD (nixpacks) — le forcer à « static » casse le build (recette
  // validée live : nixpacks + isStatic + /dist). Ne pas confondre les deux.
  const staticToggled = !!isStatic;
  const badBuildPackStatic = !!buildPack && buildPack.toLowerCase() === 'static';
  const staticMissingDir = staticToggled && !publishDir;
  // Coolify rejette (422 « publish directory field format is invalid ») un dossier
  // SANS slash de tête (ex. « dist » au lieu de « /dist ») — vérifié réel.
  const staticBadDir = staticToggled && !!publishDir && !publishDir.startsWith('/');
  const goodDir = staticToggled && !!publishDir && publishDir.startsWith('/');
  const dirWithoutStatic = !staticToggled && !!publishDir;
  const dirNotNeeded = !staticToggled && !publishDir;
  const appNameMissing = !appName;

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
      items: [
        serveName
          ? { status: 'ok', label: `Module de déploiement : ${serveName}`, hint: `${isPerClient ? 'B · projet client dédié — une app par client sur Coolify.' : 'A · projet partagé — app configurée dans un projet commun.'}`, tab: 'general' }
          : { status: 'error', label: 'Aucun module de déploiement sur le pack', hint: 'Sans module (→ serveur Coolify), aucune app ne sera créée.', tab: 'general' },
        server?.hostname
          ? { status: 'ok', label: 'Serveur Coolify configuré', hint: server.hostname }
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
          ? badBuildPackStatic
            ? { status: 'error', label: `Build pack « ${buildPack} » — casserait le build`, hint: `Le stack « static » de Coolify ne build PAS (page vide). Recette qui marche : ${DEFAULT_STATIC_DIR ? 'nixpacks' : 'nixpacks'} + cocher « Publier en statique » + publishDirectory ${DEFAULT_STATIC_DIR}.`, tab: 'boutique' }
            : { status: 'ok', label: `Build pack : ${buildPack}`, hint: staticToggled ? 'Le build (nixpacks) est ensuite servi en statique — combinaison validée.' : 'Nixpacks/autre — sert un serveur applicatif.', tab: 'boutique' }
          : { status: 'warn', label: 'Build pack vide', hint: 'Prend « nixpacks » par défaut.', tab: 'boutique' },
        // ★ Le cœur du bug « Deploy my GitHub App » : cocher « Publier en statique »
        // requiert un répertoire de publication au format exigé par Coolify.
        staticToggled ? (
          staticMissingDir ? (
            { status: 'error', label: `« Publier en statique » coché mais dossier de publication vide`, hint: `Sans publishDirectory, l’app ne sera pas servie (vide). Mettez ${DEFAULT_STATIC_DIR} pour une SPA Vite.`, tab: 'boutique' }
          ) : staticBadDir ? (
            { status: 'error', label: `Répertoire « ${publishDir} » invalide`, hint: `Coolify exige un slash de tête (422) : utilisez « /${publishDir.replace(/^\/+/, '')} », par ex. ${DEFAULT_STATIC_DIR}.`, tab: 'boutique' }
          ) : goodDir ? (
            { status: 'ok', label: `Répertoire de publication : ${publishDir}`, hint: 'Appelé à être servie en statique après le build nixpacks.', tab: 'boutique' }
          ) : (
            { status: 'ok', label: 'Répertoire de publication : (aucun)' }
          )
        ) : dirWithoutStatic ? (
          { status: 'warn', label: `publishDirectory défini (${publishDir}) mais « Publier en statique » non coché`, hint: 'Cohérence : un répertoire de publication sert surtout un build statique servi tel quel.', tab: 'boutique' }
        ) : (
          { status: 'ok', label: 'Publish directory : non requis (build non statique).' }
        ),
        isStatic
          ? { status: 'ok', label: '« Publier en statique » coché — sortie de build servie en static (nginx).', tab: 'boutique' }
          : { status: 'info', label: '« Publier en statique » non coché', hint: 'Activez-le pour qu’un site static généré (Vite) soit servi.', tab: 'boutique' },
        appNameMissing
          ? { status: 'warn', label: 'Nom d’app (appName) vide', hint: 'Prendra le nom du produit. Un nom propre évite les ambiguïtés.', tab: 'boutique' }
          : { status: 'ok', label: `Nom d’app : ${appName}`, tab: 'boutique' },
        domainRequired
          ? { status: 'info', label: 'Sous-domaine requis à la commande', hint: 'Le sous-domaine client doit être choisi/attribué avant le déploiement.', tab: 'subdomain' }
          : { status: 'info', label: 'Aucun sous-domaine imposé — sous-domaine auto basé sur le slug.' },
      ],
    },
  ];
}

/**
 * La barre de progression globale (fait / à corriger / bloquant) + sections.
 * est affichée en tête de l'éditeur (onglet Roadmap), pour guider l'admin.
 */
export function ProductRoadmapTab({
  product,
  modules,
  onNavigate,
}: {
  product: ProductAdmin;
  modules: DeploymentModule[];
  onNavigate?: (tab: RoadmapTabKey) => void;
}) {
  const sections = buildRoadmap(product, modules);
  const all = sections.flatMap((s) => s.items);
  const { ok, warn, error } = summarize(all);
  const total = all.length;
  const pct = total ? Math.round((ok / total) * 100) : 0;

  return (
    <div>
      <div className="alert info" style={{ marginBottom: 14 }}>
        <b>Roadmap de mise en configuration.</b> Suivez la checklist ci-dessous : chaque passage
        indique ce qui est fait, ce qui manque ou ce qui est incorrect/bloquant, et renvoie vers
        l&apos;onglet à corriger. Le produit n&apos;est vraiment prêt que quand il ne reste plus
        de ligne <b style={{ color: 'var(--danger)' }}>bloquante</b> ni <b style={{ color: 'var(--warning)' }}>à corriger</b>.
      </div>

      <div className="card cell" style={{ padding: '12px 14px', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
              Préparation du produit : {ok} / {total} étapes validées
            </div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
              {error > 0 && <span style={{ color: 'var(--danger)', fontWeight: 600 }}>{error} bloquant(s) · </span>}
              {warn > 0 && <span style={{ color: 'var(--warning)', fontWeight: 600 }}>{warn} à corriger · </span>}
              {warn === 0 && error === 0 && <span style={{ color: 'var(--success)' }}>Configuration complète ✓</span>}
            </div>
          </div>
          <div style={{ width: 200, maxWidth: '100%', height: 10, borderRadius: 6, background: 'var(--bg-2)', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', borderRadius: 6, background: pct === 100 ? 'var(--success)' : pct >= 60 ? 'var(--info)' : 'var(--warning)' }} />
          </div>
        </div>
      </div>

      {sections.map((s) => (
        <div key={s.section} style={{ marginBottom: 16 }}>
          <div className="section-title" style={{ marginBottom: 4 }}>
            <h3 style={{ fontSize: 13.5, margin: 0 }}>{s.section}</h3>
          </div>
          <div className="card cell" style={{ padding: '8px 14px' }}>
            {s.items.map((it) =>
              it.tab && onNavigate ? (
                <button
                  key={it.label}
                  type="button"
                  onClick={() => onNavigate(it.tab!)}
                  style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                  title={`Aller à l’onglet ${it.tab}`}
                >
                  <RoadmapRow item={it} />
                </button>
              ) : (
                <RoadmapRow key={it.label} item={it} />
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export default ProductRoadmapTab;