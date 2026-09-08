'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  addTicketMessage,
  apiError,
  BUILD_PACKS,
  cancelMySubscription,
  clearImpToken,
  createDeployment,
  detectDeployment,
  createMyService,
  createMySubscription,
  createTicket,
  decodeJwt,
  deleteMyDeployment,
  fetchMe,
  generateSupportCode,
  getMyDeployment,
  getPublicAuthConfig,
  getSessionToken,
  getSupportCodeStatus,
  githubLinkStatus,
  listGithubRepos,
  listMyDeployments,
  listMyServices,
  listMySubscriptions,
  listMyTickets,
  listPublicProducts,
  returnFromImpersonation,
  revokeSupportCode,
  upgradeMySubscription,
  type BuildPack,
  type ClientDeployQuota,
  type Deployment,
  type DetectResult,
  type GithubLinkStatus,
  type GithubRepo,
  type Me,
  type ProductRef,
  type Service,
  type Subscription,
  type Ticket,
} from '@/lib/api';
import { AppShell, ImpersonationBanner } from '@/components/app-shell';
import { CLIENT_NAV } from '@/config/nav';
import { useToast } from '@/components/toast';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  PageLoading,
  Panel,
  Select,
  StatCard,
  statusTone,
} from '@/components/ui';
import { IconBox, IconCheck, IconKey, IconLifeBuoy, IconPlus, IconRefresh, IconServer, IconTrash } from '@/components/icons';

type Phase = 'loading' | 'denied' | 'ready';

interface Product {
  id: string;
  name: string;
  kind: string;
  status: string;
  pack?: ProductRef['pack'] | null;
}

const SUB_STATUS_LABEL: Record<string, string> = {
  PENDING: 'En attente',
  ACTIVE: 'Active',
  REJECTED: 'Rejetée',
  SUSPENDED: 'Suspendue',
  CANCELLED: 'Annulée',
};
const SERVICE_STATUS_LABEL: Record<string, string> = {
  REQUESTED: 'Demandé',
  PROVISIONING: 'En provisionnement',
  ACTIVE: 'Actif',
  PROBLEM: 'Problème',
  SUSPENDED: 'Suspendu',
  REMOVED: 'Retiré',
};
const TICKET_STATUS_LABEL: Record<string, string> = {
  OPEN: 'Ouvert',
  IN_PROGRESS: 'En cours',
  WAITING_CLIENT: 'En attente client',
  RESOLVED: 'Résolu',
  CLOSED: 'Fermé',
};
const DEP_STATUS_LABEL: Record<string, string> = {
  PENDING: 'En file',
  DEPLOYING: 'Déploiement en cours',
  ACTIVE: 'Déployé',
  FAILED: 'Échec',
};

/** Barre de progression quota/ressource (classes Phase 13 dans globals.css). */
function UsageBar({
  label,
  used,
  limit,
  unit = '',
}: {
  label: string;
  used: number;
  limit: number | null;
  unit?: string;
}) {
  if (limit == null || limit <= 0) {
    return (
      <div className="bar-wrap">
        <div className="bar-meta">
          <span className="bar-label">{label}</span>
          <span className="muted">Illimité</span>
        </div>
        <div className="bar-track">
          <div className="bar-fill neutral" style={{ width: '100%' }} />
        </div>
      </div>
    );
  }
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const over = used > limit;
  return (
    <div className="bar-wrap">
      <div className="bar-meta">
        <span className="bar-label">{label}</span>
        <span className={over ? 'danger-text' : 'muted'}>
          {used} / {limit} {unit}
          {over && <Badge tone="danger">DÉPASSÉ</Badge>}
        </span>
      </div>
      <div className="bar-track">
        <div className={`bar-fill ${over ? 'danger' : 'ok'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function ClientPage() {
  const router = useRouter();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [token, setToken] = useState('');
  const [isImp, setIsImp] = useState(false);
  const [impKind, setImpKind] = useState<'admin' | 'support'>('admin');
  const [impBy, setImpBy] = useState('');

  const [products, setProducts] = useState<Product[]>([]);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [serviceName, setServiceName] = useState<Record<string, string>>({});

  // Support code (accès support).
  const [codeActive, setCodeActive] = useState(false);
  const [codeExpiry, setCodeExpiry] = useState<string | null>(null);
  const [shownCode, setShownCode] = useState<string | null>(null);

  // Mes tickets.
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);
  const [ticketReply, setTicketReply] = useState<Record<string, string>>({});
  const [tSubject, setTSubject] = useState('');
  const [tBody, setTBody] = useState('');

  // Déploiements GitHub → Coolify (Phase 10bis) — panneau masqué si désactivé.
  const [deployEnabled, setDeployEnabled] = useState(false);
  const [github, setGithub] = useState<GithubLinkStatus | null>(null);
  const [repos, setRepos] = useState<GithubRepo[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [depRepo, setDepRepo] = useState('');
  const [depBranch, setDepBranch] = useState('');
  // Mode URL collée (Phase 10bis.5) — détection auto, champs éditables.
  const [depTab, setDepTab] = useState<'github' | 'url'>('github');
  const [depUrl, setDepUrl] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState<DetectResult | null>(null);
  const [depAppName, setDepAppName] = useState('');
  const [depBuildPack, setDepBuildPack] = useState<BuildPack>('nixpacks');
  // Phase 3 — sous-domaine gratuit (optionnel) ; vide = slug auto.
  const [depSubdomain, setDepSubdomain] = useState('');
  // Quota d'apps du pack ACTIF (Phase 13).
  const [quota, setQuota] = useState<ClientDeployQuota | null>(null);
  // Suppression d'une app (confirmation en deux temps) + mise à niveau du plan.
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [upgradingId, setUpgradingId] = useState<string | null>(null);

  const load = useCallback(
    async (t: string) => {
      try {
        const [p, s, svc] = await Promise.all([
          listPublicProducts(),
          listMySubscriptions(t),
          listMyServices(t),
        ]);
        setProducts((p.data as Product[]) ?? []);
        setSubs((s.data as Subscription[]) ?? []);
        setServices((svc.data as Service[]) ?? []);
      } catch {
        toast.error('Impossible de charger l’espace client.');
      }
    },
    [toast],
  );

  const loadCodeStatus = useCallback(
    async (t: string) => {
      const r = await getSupportCodeStatus(t);
      if (r.ok) {
        const d = r.data as { active: boolean; expiresAt?: string | null };
        setCodeActive(!!d.active);
        setCodeExpiry(d.expiresAt ?? null);
      }
    },
    [],
  );

  const loadTickets = useCallback(async (t: string) => {
    const r = await listMyTickets(t);
    if (r.ok) setTickets((r.data as Ticket[]) ?? []);
  }, []);

  // GitHub (Phase 10bis) : état de la liaison + repos autodétectés.
  const loadGithub = useCallback(async (t: string) => {
    const [ls, r] = await Promise.all([githubLinkStatus(t), listGithubRepos(t)]);
    if (ls.ok) setGithub((ls.data as GithubLinkStatus) ?? null);
    if (r.ok) setRepos((r.data as GithubRepo[]) ?? []);
  }, []);

  // Déploiements + rafraîchissement live des statuts en cours + quota du pack (Phase 13).
  const loadDeployments = useCallback(async (t: string) => {
    const r = await listMyDeployments(t);
    if (!r.ok) return;
    const payload = r.data as { deployments: Deployment[]; quota: ClientDeployQuota | null } | Deployment[] | null;
    // Ancien format (fallback) : tableau direct. Nouveau (Phase 13) : { deployments, quota }.
    let list = Array.isArray(payload) ? payload : (payload?.deployments ?? []);
    if (payload && !Array.isArray(payload)) {
      setQuota(payload.quota);
    }
    const live = await Promise.all(
      list.filter((d) => d.status === 'DEPLOYING').map((d) => getMyDeployment(t, d.id)),
    );
    const byId = new Map<string, Deployment>();
    for (const item of live) {
      const d = item.data as Deployment | null;
      if (item.ok && d) byId.set(d.id, d);
    }
    list = list.map((d) => byId.get(d.id) ?? d);
    setDeployments(list);
  }, []);

  useEffect(() => {
    (async () => {
      const t = await getSessionToken();
      if (!t) {
        router.replace('/auth');
        return;
      }
      const m = await fetchMe(t);
      if (!m) {
        setPhase('denied');
        return;
      }
      const dec = decodeJwt(t);
      setToken(t);
      setMe(m);
      setIsImp(!!dec?.imp);
      setImpKind(dec?.imp?.kind ?? 'admin');
      setImpBy(dec?.imp?.by ?? '');
      setPhase('ready');
      void load(t);
      void loadCodeStatus(t);
      void loadTickets(t);
      const cfg = await getPublicAuthConfig();
      if (cfg?.deployEnabled) {
        setDeployEnabled(true);
        void loadGithub(t);
        void loadDeployments(t);
      }
    })();
  }, [router, load, loadCodeStatus, loadTickets, loadGithub, loadDeployments]);

  // Auto-poll : tant qu'un déploiement est en cours, re-sonde toutes les 8 s.
  useEffect(() => {
    if (!deployEnabled || !token) return;
    const hasDeploying = deployments.some((d) => d.status === 'DEPLOYING');
    if (!hasDeploying) return;
    const id = setInterval(() => void loadDeployments(token), 8000);
    return () => clearInterval(id);
  }, [deployEnabled, token, deployments, loadDeployments]);

  async function subscribe(productId: string) {
    const r = await createMySubscription(token, productId);
    if (!r.ok) return toast.error(apiError(r, 'Impossible de souscrire.'));
    toast.ok('Souscription envoyée — en attente d’approbation par l’admin.');
    void load(token);
  }

  async function cancelSub(id: string) {
    const r = await cancelMySubscription(token, id);
    if (!r.ok) return toast.error(apiError(r, 'Impossible d’annuler.'));
    toast.ok('Souscription annulée.');
    void load(token);
  }

  async function requestService(subId: string) {
    const name = (serviceName[subId] ?? '').trim();
    if (!name) return;
    const r = await createMyService(token, subId, name);
    if (!r.ok) return toast.error(apiError(r, 'Impossible de demander un service.'));
    setServiceName({ ...serviceName, [subId]: '' });
    toast.ok('Service demandé.');
    void load(token);
  }

  // Accès support.
  async function generateCode() {
    const r = await generateSupportCode(token);
    if (!r.ok) return toast.error(apiError(r, 'Génération impossible.'));
    const d = r.data as { code: string; expiresAt: string };
    setShownCode(d.code);
    setCodeActive(true);
    setCodeExpiry(d.expiresAt);
    try {
      await navigator.clipboard?.writeText(d.code);
    } catch {
      /* clipboard indisponible — l'utilisateur recopie */
    }
    toast.info('Code affiché une seule fois — transmettez-le au support par téléphone.');
  }

  async function revokeCode() {
    const r = await revokeSupportCode(token);
    if (!r.ok) return toast.error(apiError(r, 'Révocation impossible.'));
    setCodeActive(false);
    setCodeExpiry(null);
    setShownCode(null);
    toast.ok('Code d’accès révoqué.');
  }

  // Tickets.
  async function openTicket() {
    if (!tSubject.trim() || !tBody.trim()) return;
    const r = await createTicket(token, { subject: tSubject.trim(), body: tBody.trim() });
    if (!r.ok) return toast.error(apiError(r, 'Ouverture impossible.'));
    setTSubject('');
    setTBody('');
    toast.ok('Ticket ouvert — le support vous répondra.');
    void loadTickets(token);
  }

  async function sendTicketReply(id: string) {
    const body = (ticketReply[id] ?? '').trim();
    if (!body) return;
    const r = await addTicketMessage(token, id, body);
    if (!r.ok) return toast.error(apiError(r, 'Réponse impossible.'));
    setTicketReply({ ...ticketReply, [id]: '' });
    toast.ok('Message ajouté.');
    void loadTickets(token);
  }

  // Déploiements (Phase 10bis).
  function onRepoChange(fullName: string) {
    setDepRepo(fullName);
    const repo = repos.find((x) => x.fullName === fullName);
    setDepBranch(repo?.defaultBranch ?? '');
  }

  async function deploy() {
    if (!depRepo) return;
    const branch = depBranch.trim() || 'main';
    const r = await createDeployment(token, {
      repoFullName: depRepo,
      branch,
      subdomain: depSubdomain.trim() || undefined,
    });
    if (!r.ok) return toast.error(apiError(r, 'Déploiement impossible.'));
    toast.ok('Déploiement déclenché — statut en direct ci-dessous.');
    void loadDeployments(token);
  }

  // Mode URL collée (Phase 10bis.5) : Détecter → préremplit la branche + le
  // build pack suggéré ; le client peut corriger Nom de l'app et Build pack.
  async function onDetect() {
    const url = depUrl.trim();
    if (!url) return;
    setDetecting(true);
    const r = await detectDeployment(token, url);
    setDetecting(false);
    if (!r.ok) return toast.error(apiError(r, 'Détection impossible.'));
    const d = r.data as DetectResult | null;
    if (!d) return toast.error('Détection impossible.');
    setDetected(d);
    setDepAppName(d.repoFullName?.split('/').pop() ?? '');
    setDepBuildPack(
      (BUILD_PACKS as readonly string[]).includes(d.suggestedBuildPack)
        ? (d.suggestedBuildPack as BuildPack)
        : 'nixpacks',
    );
    toast.ok(d.detail ? `Détecté — ${d.detail}` : 'Dépôt détecté — vérifiez puis déployez.');
  }

  async function deployUrl() {
    if (!detected?.repoUrl) return;
    const r = await createDeployment(token, {
      repoUrl: detected.repoUrl,
      branch: detected.defaultBranch, // branche auto (non éditée dans l'UI)
      buildPack: depBuildPack,
      appName: depAppName.trim() || undefined,
      subdomain: depSubdomain.trim() || undefined,
    });
    if (!r.ok) return toast.error(apiError(r, 'Déploiement impossible.'));
    toast.ok('Déploiement déclenché — statut en direct ci-dessous.');
    void loadDeployments(token);
  }

  /**
   * Suppression d'une app (Phase 13) : confirmation en deux temps, puis
   * DELETE /client/deployments/:id (app Coolify + CNAME supprimés best-effort,
   * quota libéré). Après suppression, le compteur d'apps du plan baisse.
   */
  async function deleteApp(d: Deployment) {
    if (confirmDel !== d.id) {
      setConfirmDel(d.id);
      return;
    }
    setConfirmDel(null);
    setDeleting(true);
    const r = await deleteMyDeployment(token, d.id);
    setDeleting(false);
    if (!r.ok) return toast.error(apiError(r, 'Suppression impossible.'));
    toast.ok(`Application « ${d.appName ?? d.repoFullName.split('/').pop()} » supprimée — quota libéré.`);
    void loadDeployments(token);
  }

  /**
   * Mise à niveau du plan (Phase 13) : bascule la MÊME souscription ACTIVE vers
   * un produit/pack supérieur — applications et données préservées, seules les
   * limites/quota des prochains déploiements changent.
   */
  async function upgradeTo(subId: string, productId: string) {
    setUpgradingId(productId);
    const r = await upgradeMySubscription(token, subId, productId);
    setUpgradingId(null);
    if (!r.ok) return toast.error(apiError(r, 'Mise à niveau impossible.'));
    toast.ok('Plan mis à niveau — vos applications sont conservées.');
    void load(token);
    void loadDeployments(token);
  }

  async function onReturn() {
    try {
      await returnFromImpersonation(token);
    } catch {
      /* audit best-effort */
    }
    clearImpToken();
    router.replace(impKind === 'admin' ? '/manager/utilisateurs' : '/manager/support');
  }

  if (phase === 'loading') {
    return (
      <AppShell me={null} nav={CLIENT_NAV}>
        <PageLoading />
      </AppShell>
    );
  }

  if (phase === 'denied') {
    return (
      <AppShell me={null} nav={CLIENT_NAV} tenant={{ label: 'Espace client' }}>
        <div className="auth-wrap">
          <div className="auth-card">
            <h2>Connexion requise</h2>
            <p>Connecte-toi pour accéder à ton espace client.</p>
            <a className="btn-primary" href="/auth">
              Se connecter
            </a>
          </div>
        </div>
      </AppShell>
    );
  }

  const activeSub = subs.find((s) => s.status === 'ACTIVE') ?? null;
  const currentPack = activeSub?.product?.pack ?? null;
  const availablePlans = products.filter((p) => p.status === 'ACTIVE' && p.pack);
  const banner = isImp ? (
    <ImpersonationBanner targetEmail={me?.email ?? ''} kind={impKind} onReturn={onReturn} />
  ) : null;

  return (
    <AppShell me={me} nav={CLIENT_NAV} tenant={{ label: 'Espace client' }} banner={banner}>
      <div className="wrap-lg">
        {/* ── Héros ─────────────────────────────────────────────────────── */}
        <div className="dash-hero">
          <div>
            <div className="hero-eyebrow">Espace client</div>
            <h2>Bonjour{me?.name ? `, ${me.name.split(' ')[0]}` : ''} 👋</h2>
            <p>
              Gérez vos applications, votre plan d’hébergement et vos demandes de support depuis
              un seul tableau de bord. L’infrastructure reste pilotée par l’équipe.
            </p>
          </div>
          <div className="dash-hero-actions">
            <a className="quick-link" href="/profil">
              <IconKey /> Gérer mon compte
            </a>
            <a className="quick-link" href="/aide">
              <IconLifeBuoy /> Centre d’aide
            </a>
          </div>
        </div>

        {/* ── Aperçu (stat cards) ───────────────────────────────────────── */}
        {deployEnabled && quota && (
          <div className="stat-row">
            <StatCard
              label="Applications"
              value={quota.used}
              unit={quota.pack.maxApps ? `/ ${quota.pack.maxApps}` : '/ ∞'}
              warn={quota.pack.maxApps != null && quota.used > quota.pack.maxApps}
              tone="primary"
              icon={<IconBox />}
              sub={quota.pack.maxApps
                ? quota.used >= quota.pack.maxApps
                  ? 'Quota atteint — supprimez ou passez au plan supérieur'
                  : `${quota.pack.maxApps - quota.used} place(s) restante(s)`
                : 'Illimité'}
            />
            <StatCard
              label="RAM par app"
              value={quota.pack.ramMb}
              unit="Mo"
              tone="info"
              icon={<IconServer />}
              sub="Limite appliquée par déploiement"
            />
            <StatCard
              label="CPU par app"
              value={quota.pack.cpuCores}
              unit="cœurs"
              tone="violet"
              icon={<IconServer />}
              sub="Limite appliquée par déploiement"
            />
            <StatCard
              label="Plan actuel"
              value={quota.pack.name}
              tone="amber"
              icon={<IconCheck />}
              sub={activeSub?.product?.name ?? 'Pack actif'}
            />
          </div>
        )}

        {/* ── Mes applications (déploiement + cartes) ───────────────────── */}
        {deployEnabled && (
          <div className="mt">
            <div className="section-title">
              <h3>Mes applications</h3>
              <span className="muted">
                {deployments.length} déploiement(s) ·{' '}
                <Button variant="ghost" size="sm" disabled={isImp} onClick={() => loadDeployments(token)}>
                  <IconRefresh /> Actualiser
                </Button>
              </span>
            </div>

            <Panel
              title="Déployer une application"
              sub="Deux façons : coller l’URL d’un dépôt git (détection automatique), ou choisir un dépôt de votre compte GitHub lié. La cible (serveur + projet Coolify) est résolue automatiquement depuis votre pack."
            >
              {!github ? (
                <EmptyState>Chargement…</EmptyState>
              ) : (
                <div className="stack">
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    {github.linked && (
                      <Button
                        variant={depTab === 'github' ? 'primary' : 'secondary'}
                        size="sm"
                        disabled={isImp}
                        onClick={() => setDepTab('github')}
                      >
                        Dépôt GitHub lié
                      </Button>
                    )}
                    <Button
                      variant={depTab === 'url' ? 'primary' : 'secondary'}
                      size="sm"
                      disabled={isImp}
                      onClick={() => setDepTab('url')}
                    >
                      URL d&apos;un dépôt
                    </Button>
                  </div>

                  {depTab === 'github' && github.linked ? (
                    <div className="inline-form">
                      <Field label="Dépôt GitHub">
                        <Select
                          value={depRepo}
                          disabled={isImp}
                          onChange={(e) => onRepoChange(e.target.value)}
                        >
                          <option value="">Choisir un dépôt…</option>
                          {repos.map((r) => (
                            <option key={r.fullName} value={r.fullName}>
                              {r.fullName}
                              {r.private ? ' 🔒' : ''}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Branche">
                        <Input
                          className="input-sm"
                          placeholder="main"
                          value={depBranch}
                          disabled={isImp}
                          onChange={(e) => setDepBranch(e.target.value)}
                        />
                      </Field>
                      <Field
                        label="Sous-domaine (optionnel)"
                        hint="Libre ; vide = slug auto depuis le nom de l'app."
                      >
                        <Input
                          className="input-sm"
                          placeholder="mon-app"
                          value={depSubdomain}
                          disabled={isImp}
                          onChange={(e) => setDepSubdomain(e.target.value)}
                        />
                      </Field>
                      <Button disabled={isImp || !depRepo} onClick={deploy}>
                        <IconPlus /> Déployer
                      </Button>
                    </div>
                  ) : (
                    <div className="stack">
                      {!github.linked && (
                        <p className="muted" style={{ fontSize: 13 }}>
                          La liaison GitHub est optionnelle — collez simplement l&apos;URL de votre
                          dépôt. (Vous pouvez aussi <a href="/profil">lier votre compte GitHub</a> pour
                          choisir un dépôt.)
                        </p>
                      )}
                      <div className="inline-form">
                        <Field label="URL du dépôt git">
                          <Input
                            className="flex-1"
                            placeholder="https://github.com/vous/mon-projet.git"
                            value={depUrl}
                            disabled={isImp || detecting}
                            onChange={(e) => setDepUrl(e.target.value)}
                          />
                        </Field>
                        <Button
                          variant="secondary"
                          disabled={isImp || detecting || !depUrl.trim()}
                          onClick={onDetect}
                        >
                          {detecting ? 'Détection…' : 'Détecter'}
                        </Button>
                      </div>

                      {detected ? (
                        <div
                          className="stack"
                          style={{ padding: '14px 16px', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--card-bg-2)' }}
                        >
                          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                            <div className="muted" style={{ fontSize: 13 }}>
                              Repo : <b style={{ color: 'var(--text)' }}>{detected.repoFullName ?? detected.repoUrl}</b>
                              {detected.language ? ` · ${detected.language}` : ''}
                            </div>
                            <div className="muted" style={{ fontSize: 13 }}>
                              Branche : <b style={{ color: 'var(--text)' }}>{detected.defaultBranch}</b>{' '}
                              (auto)
                            </div>
                          </div>
                          {detected.detail && (
                            <div className="muted" style={{ fontSize: 12.5 }}>{detected.detail}</div>
                          )}
                          <div className="inline-form">
                            <Field label="Nom de l’app" hint="Nom de l’application côté Coolify.">
                              <Input
                                className="input-sm"
                                value={depAppName}
                                disabled={isImp}
                                onChange={(e) => setDepAppName(e.target.value)}
                              />
                            </Field>
                            <Field label="Build pack" hint="Suggéré par la détection, modifiable.">
                              <Select
                                value={depBuildPack}
                                disabled={isImp}
                                onChange={(e) => setDepBuildPack(e.target.value as BuildPack)}
                              >
                                {BUILD_PACKS.map((b) => (
                                  <option key={b} value={b}>
                                    {b}
                                  </option>
                                ))}
                              </Select>
                            </Field>
                            <Field
                              label="Sous-domaine (optionnel)"
                              hint="Libre ; vide = slug auto. Vous obtenez une URL en https://."
                            >
                              <Input
                                className="input-sm"
                                placeholder="mon-app"
                                value={depSubdomain}
                                disabled={isImp}
                                onChange={(e) => setDepSubdomain(e.target.value)}
                              />
                            </Field>
                            <Button disabled={isImp || !detected.repoUrl} onClick={deployUrl}>
                              <IconPlus /> Déployer
                            </Button>
                          </div>
                        </div>
                      ) : (
                        !detecting && (
                          <EmptyState>
                            Collez l&apos;URL du dépôt puis « Détecter » pour préremplir la branche
                            et le build pack.
                          </EmptyState>
                        )
                      )}
                    </div>
                  )}

                  {/* Quota d'apps du pack — compteur + barre (Phase 13). */}
                  {quota && (
                    <div
                      className="stack"
                      style={{
                        padding: '14px 16px',
                        border: '1px solid var(--border)',
                        borderRadius: 12,
                        background: 'var(--tint-blue-bg)',
                      }}
                    >
                      <UsageBar
                        label={`Quota d'applications — plan ${quota.pack.name}`}
                        used={quota.used}
                        limit={quota.pack.maxApps}
                      />
                    </div>
                  )}
                </div>
              )}
            </Panel>

            {/* Cartes des applications */}
            <div className="mt">
              {deployments.length === 0 ? (
                <EmptyState>Déployez votre première application ci-dessus.</EmptyState>
              ) : (
                <div className="grid">
                  {deployments.map((d) => (
                    <div key={d.id} className="panel app-card">
                      <div className="app-card-head">
                        <div className="app-card-title">
                          {d.appName ?? d.repoFullName.split('/').pop() ?? 'App'}
                        </div>
                        <Badge tone={statusTone(DEP_TONE(d.status))}>
                          {DEP_STATUS_LABEL[d.status] ?? d.status}
                        </Badge>
                      </div>

                      {d.fqdn && (
                        <a
                          href={`https://${d.fqdn}`}
                          target="_blank"
                          rel="noreferrer"
                          className="btn-secondary btn-sm"
                          style={{ alignSelf: 'flex-start' }}
                        >
                          https://{d.fqdn}
                        </a>
                      )}

                      <div className="app-card-meta">
                        <span className="app-chip">{d.repoFullName}</span>
                        <span className="app-chip">branche {d.branch}</span>
                        <span className="app-chip">{d.buildPack ?? '—'}</span>
                      </div>

                      {d.status === 'FAILED' && d.detail && (
                        <div className="muted" style={{ fontSize: 12.5, color: 'var(--tint-red-fg)' }}>
                          {d.detail}
                        </div>
                      )}
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        Créé le {new Date(d.createdAt).toLocaleString()}
                      </div>

                      <div className="app-card-foot">
                        <div className="row" style={{ gap: 14, fontSize: 12.5 }}>
                          <span>
                            <b>RAM :</b> {quota?.pack.ramMb ?? '—'} Mo
                          </span>
                          <span>
                            <b>CPU :</b> {quota?.pack.cpuCores ?? '—'} cœurs
                          </span>
                        </div>
                        <Button
                          variant={confirmDel === d.id ? 'danger' : 'secondary'}
                          size="sm"
                          disabled={isImp || deleting}
                          onClick={() => deleteApp(d)}
                        >
                          <IconTrash />
                          {confirmDel === d.id ? 'Confirmer ?' : 'Supprimer'}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Mon plan + mise à niveau ──────────────────────────────────── */}
        <div className="mt">
          <div className="section-title">
            <h3>Mon plan d’hébergement</h3>
            <span className="muted">La mise à niveau conserve vos applications et vos données.</span>
          </div>

          <Panel
            title={activeSub ? 'Souscription active' : 'Aucune souscription active'}
            sub={
              activeSub
                ? `${activeSub.product?.name ?? activeSub.productId} · souscrite le ${new Date(activeSub.createdAt).toLocaleDateString()}`
                : 'Souscrivez à une offre ci-dessous pour déployer vos applications.'
            }
          >
            {activeSub && currentPack ? (
              <div className="plan-card">
                <div className="plan-card-head">
                  <div>
                    <div className="plan-name">{currentPack.name}</div>
                    <div className="muted" style={{ fontSize: 12.5 }}>
                      Pack d’hébergement actif
                    </div>
                  </div>
                  <Badge tone="ok">ACTIF</Badge>
                </div>
                <div className="plan-specs">
                  <span className="app-chip">RAM {currentPack.ramMb} Mo / app</span>
                  <span className="app-chip">CPU {currentPack.cpuCores} cœurs / app</span>
                  {currentPack.storageLimit && (
                    <span className="app-chip">Disque {currentPack.storageLimit} Go</span>
                  )}
                  <span className="app-chip">
                    {currentPack.maxApps
                      ? `${currentPack.maxApps} app(s) max`
                      : 'Apps illimitées'}
                  </span>
                  {currentPack.deploymentModule && (
                    <span className="app-chip">Module {currentPack.deploymentModule.code} — {currentPack.deploymentModule.name}</span>
                  )}
                </div>
              </div>
            ) : (
              <EmptyState>
                {subs.length === 0
                  ? 'Demandez une offre ci-dessous : une souscription active débloque le déploiement.'
                  : 'Votre souscription est en attente d’approbation par l’admin.'}
              </EmptyState>
            )}

            {activeSub && availablePlans.length > 0 && (
              <div className="stack mt" style={{ marginTop: 16 }}>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  Changer de plan (mise à niveau) :
                </div>
                {availablePlans
                  .filter((p) => p.id !== activeSub.productId)
                  .map((p) => (
                    <div key={p.id} className="upgrade-row">
                      <div className="upgrade-main">
                        <div className="upgrade-title">{p.name}</div>
                        <div className="upgrade-sub">
                          {p.pack
                            ? `${p.pack.name} · ${p.pack.ramMb} Mo RAM · ${p.pack.cpuCores} CPU${p.pack.maxApps ? ` · ${p.pack.maxApps} apps` : ' · apps illimitées'}${p.pack.storageLimit ? ` · ${p.pack.storageLimit} Go` : ''}`
                            : 'Pack non configuré'}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        disabled={isImp || upgradingId === p.id}
                        busy={upgradingId === p.id}
                        onClick={() => upgradeTo(activeSub.id, p.id)}
                      >
                        Mettre à niveau
                      </Button>
                    </div>
                  ))}
              </div>
            )}

            {!activeSub && (
              <div className="stack mt" style={{ marginTop: 16 }}>
                {availablePlans.length === 0 ? (
                  <EmptyState>Aucune offre disponible pour l&apos;instant.</EmptyState>
                ) : (
                  availablePlans.map((p) => (
                    <div key={p.id} className="upgrade-row">
                      <div className="upgrade-main">
                        <div className="upgrade-title">{p.name}</div>
                        <div className="upgrade-sub">
                          {p.pack
                            ? `${p.pack.name} · ${p.pack.ramMb} Mo RAM · ${p.pack.cpuCores} CPU${p.pack.maxApps ? ` · ${p.pack.maxApps} apps` : ' · apps illimitées'}`
                            : 'Pack non configuré'}
                        </div>
                      </div>
                      <Button size="sm" disabled={isImp} onClick={() => subscribe(p.id)}>
                        Souscrire
                      </Button>
                    </div>
                  ))
                )}
              </div>
            )}
          </Panel>
        </div>

        {/* ── Souscriptions & services ──────────────────────────────────── */}
        <div className="mt">
          <div className="section-title">
            <h3>Souscriptions &amp; services</h3>
            <span className="muted">Les serveurs ne sont jamais exposés côté client.</span>
          </div>

          <div className="bottom-grid">
            <Panel
              title="Mes souscriptions"
              sub="Une offre demandée reste en attente jusqu’à l’approbation par l’admin."
            >
              {subs.length === 0 ? (
                <EmptyState>Demandez l&apos;une des offres ci-dessus.</EmptyState>
              ) : (
                <div className="stack">
                  {subs.map((s) => (
                    <div key={s.id} className="status-row">
                      <span className="status-icon">
                        <IconServer />
                      </span>
                      <div className="status-row-main">
                        <div className="status-row-title">{s.product?.name ?? s.productId}</div>
                        <div className="status-row-sub">Souscription</div>
                      </div>
                      <Badge tone={statusTone(s.status)}>{SUB_STATUS_LABEL[s.status] ?? s.status}</Badge>
                      {!isImp && ['PENDING', 'ACTIVE', 'SUSPENDED'].includes(s.status) && (
                        <Button size="sm" variant="secondary" onClick={() => cancelSub(s.id)}>
                          Annuler
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            <Panel
              title="Mes services"
              sub="Demandez un service sous une souscription active."
            >
              {services.length === 0 ? (
                <EmptyState>
                  {activeSub ? 'Aucun service pour l’instant — demandez-en un ci-dessous.' : 'Aucune souscription active pour demander un service.'}
                </EmptyState>
              ) : (
                <div className="stack">
                  {services.map((svc) => (
                    <div key={svc.id} className="status-row">
                      <span className="status-icon">
                        <IconServer />
                      </span>
                      <div className="status-row-main">
                        <div className="status-row-title">{svc.name}</div>
                        <div className="status-row-sub">
                          Service
                          {svc.subscription?.product?.pack && (
                            <span className="muted">
                              {' '}
                              · pack {svc.subscription.product.pack.name} ({svc.subscription.product.pack.ramMb} Mo · {svc.subscription.product.pack.cpuCores} CPU)
                            </span>
                          )}
                        </div>
                      </div>
                      <Badge tone={statusTone(svc.status)}>{SERVICE_STATUS_LABEL[svc.status] ?? svc.status}</Badge>
                    </div>
                  ))}
                </div>
              )}
              {activeSub && (
                <div className="row mt" style={{ gap: 8 }}>
                  <Input
                    className="flex-1"
                    placeholder="Nom du nouveau service"
                    value={serviceName[activeSub.id] ?? ''}
                    disabled={isImp}
                    onChange={(e) => setServiceName({ ...serviceName, [activeSub.id]: e.target.value })}
                  />
                  <Button
                    size="sm"
                    disabled={isImp || !(serviceName[activeSub.id] ?? '').trim()}
                    onClick={() => requestService(activeSub.id)}
                  >
                    Demander
                  </Button>
                </div>
              )}
            </Panel>
          </div>
        </div>

        {/* ── Support & tickets ─────────────────────────────────────────── */}
        <div className="mt">
          <div className="section-title">
            <h3>Support &amp; assistance</h3>
            <span className="muted">Code d’accès en lecture seule + tickets.</span>
          </div>

          <div className="bottom-grid">
            <Panel
              title="Accès support"
              sub="Générez un code à 6 chiffres et transmettez-le au support (par téléphone) pour qu’il consulte votre espace en lecture seule."
            >
              {shownCode ? (
                <div className="stack">
                  <p className="muted" style={{ fontSize: 13 }}>
                    Code d&apos;accès (affiché une seule fois) :
                  </p>
                  <div className="row">
                    <code className="input-mono access-code">{shownCode}</code>
                    <Button variant="secondary" size="sm" onClick={revokeCode} disabled={isImp}>
                      Révoquer le code
                    </Button>
                  </div>
                  {codeExpiry && (
                    <p className="muted" style={{ fontSize: 12 }}>
                      Expire le {new Date(codeExpiry).toLocaleString()}.
                    </p>
                  )}
                </div>
              ) : codeActive ? (
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="muted" style={{ fontSize: 13 }}>
                    Un code est actif jusqu&apos;au {codeExpiry ? new Date(codeExpiry).toLocaleString() : '—'}.
                  </span>
                  <Button variant="secondary" size="sm" onClick={revokeCode} disabled={isImp}>
                    Révoquer
                  </Button>
                </div>
              ) : (
                <Button onClick={generateCode} disabled={isImp}>
                  Générer un code
                </Button>
              )}
            </Panel>

            <Panel
              title="Mes tickets"
              sub="Ouvrez un ticket auprès du support (L1 vous répond, puis escalade vers L2/L3 si besoin)."
            >
              {!isImp && (
                <div className="stack mb">
                  <div className="inline-form">
                    <Field label="Sujet">
                      <Input value={tSubject} onChange={(e) => setTSubject(e.target.value)} />
                    </Field>
                    <Button onClick={openTicket} disabled={!tSubject.trim() || !tBody.trim()}>
                      Ouvrir un ticket
                    </Button>
                  </div>
                  <Field label="Description du problème">
                    <Input value={tBody} onChange={(e) => setTBody(e.target.value)} />
                  </Field>
                </div>
              )}

              {tickets.length === 0 ? (
                <EmptyState>Aucun ticket pour l&apos;instant.</EmptyState>
              ) : (
                <div className="stack">
                  {tickets.map((t) => {
                    const open = openTicketId === t.id;
                    return (
                      <div key={t.id} className="panel ticket-msg">
                        <button
                          type="button"
                          className="status-row"
                          style={{ width: '100%', background: 'transparent', border: 0, textAlign: 'left', cursor: 'pointer' }}
                          onClick={() => setOpenTicketId(open ? null : t.id)}
                        >
                          <div className="status-row-main">
                            <div className="status-row-title">{t.subject}</div>
                            <div className="status-row-sub">
                              {TICKET_STATUS_LABEL[t.status] ?? t.status}
                              {t.escalatedTo && ` · escaladé vers ${t.escalatedTo}`} ·{' '}
                              {new Date(t.updatedAt).toLocaleString()}
                            </div>
                          </div>
                          <Badge tone={statusTone(TICKET_TONE(t.status))}>{TICKET_STATUS_LABEL[t.status] ?? t.status}</Badge>
                        </button>

                        {open && (
                          <div className="stack mt" style={{ padding: '0 4px' }}>
                            {t.messages?.map((m) => (
                              <div key={m.id} className="ticket-msg">
                                <div className="row" style={{ gap: 8 }}>
                                  <b style={{ fontSize: 12.5 }}>{m.authorEmail}</b>
                                  <span className="muted" style={{ fontSize: 11.5 }}>
                                    {new Date(m.createdAt).toLocaleString()}
                                  </span>
                                </div>
                                <div className="mt-sm" style={{ fontSize: 13.5, whiteSpace: 'pre-wrap' }}>
                                  {m.body}
                                </div>
                              </div>
                            ))}
                            {!isImp && (
                              <div className="row">
                                <Input
                                  className="flex-1"
                                  placeholder="Votre réponse…"
                                  value={ticketReply[t.id] ?? ''}
                                  onChange={(e) => setTicketReply({ ...ticketReply, [t.id]: e.target.value })}
                                />
                                <Button
                                  size="sm"
                                  disabled={!(ticketReply[t.id] ?? '').trim()}
                                  onClick={() => sendTicketReply(t.id)}
                                >
                                  Répondre
                                </Button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Panel>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

/** Map a ticket status to a statusTone-compatible value for the badge. */
function TICKET_TONE(status: string): string {
  if (status === 'RESOLVED') return 'ACTIVE';
  if (status === 'CLOSED') return 'CANCELLED';
  if (status === 'WAITING_CLIENT') return 'PENDING';
  if (status === 'IN_PROGRESS') return 'REQUESTED';
  return status;
}

/** Map a deployment status to a statusTone-compatible value for the badge. */
function DEP_TONE(status: string): string {
  if (status === 'ACTIVE') return 'ACTIVE';
  if (status === 'FAILED') return 'CANCELLED';
  if (status === 'DEPLOYING') return 'PENDING';
  if (status === 'PENDING') return 'REQUESTED';
  return status;
}
