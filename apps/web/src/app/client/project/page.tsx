'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  apiError,
  BUILD_PACKS,
  checkRepoEmpty,
  createDeployment,
  decodeJwt,
  detectDeployment,
  fetchMe,
  getSessionToken,
  githubLinkStatus,
  listGithubRepos,
  previewBuildConfig,
  type BuildConfig,
  type BuildPack,
  type ClientDeployQuota,
  type DetectResult,
  type GithubLinkStatus,
  type GithubRepo,
  type Me,
} from '@/lib/api';
import { AppShell } from '@/components/app-shell';
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
} from '@/components/ui';
import { IconCheck, IconChevronLeft, IconCopy, IconPlus, IconTrash } from '@/components/icons';

type Phase = 'loading' | 'denied' | 'ready';
type Entry = 'github' | 'url';

interface EnvRow {
  key: string;
  value: string;
}

/**
 * Phase 16 — « Créer un nouveau Projet » (Netlify-style).
 * Deux entrées : un dépôt du compte GitHub lié, ou un lien GitHub collé.
 * - Dépôt vide → message Netlify exact, création bloquée.
 * - Sinon → config de build pré-remplie depuis codediali.toml / netlify.toml /
 *   détection serveur (jamais autoritaire venant du client), éditée sur une
 *   page de build professionnelle → « Déployer » → /client.
 * L'infrastructure (hostname/token Coolify) n'est jamais exposée.
 */
export default function ClientProjectPage() {
  const router = useRouter();
  const toast = useToast();

  const [phase, setPhase] = useState<Phase>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [token, setToken] = useState('');
  const [isImp, setIsImp] = useState(false);
  const [quota, setQuota] = useState<ClientDeployQuota | null>(null);

  // Sources d'entrée.
  const [entry, setEntry] = useState<Entry>('github');
  const [github, setGithub] = useState<GithubLinkStatus | null>(null);
  const [repos, setRepos] = useState<GithubRepo[]>([]);

  // Mode URL collée.
  const [url, setUrl] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState<DetectResult | null>(null);

  // Identité du dépôt cible + branch (résolue à l'entrée).
  const [repoFullName, setRepoFullName] = useState('');
  const [branch, setBranch] = useState('');

  // Pré-visualisation : repo vide (bloquant) + config de build pré-remplie.
  const [emptyRepo, setEmptyRepo] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<BuildConfig | null>(null);

  // Page de build professionnelle (pré-remplie, éditée par le client).
  const [appName, setAppName] = useState('');
  const [buildPack, setBuildPack] = useState<BuildPack | ''>('');
  const [baseDirectory, setBaseDirectory] = useState('');
  const [buildCommand, setBuildCommand] = useState('');
  const [installCommand, setInstallCommand] = useState('');
  const [publishDirectory, setPublishDirectory] = useState('');
  const [functionsDirectory, setFunctionsDirectory] = useState('');
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const [subdomain, setSubdomain] = useState('');
  const [deploying, setDeploying] = useState(false);

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
      setPhase('ready');
      // Quota d'apps + scan des sources selon la liaison GitHub.
      const [ls, deps] = await Promise.all([
        githubLinkStatus(t),
        fetch('/api/client/deployments', {
          headers: { Authorization: `Bearer ${t}` },
        }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (ls.ok) {
        const st = ls.data as GithubLinkStatus | null;
        setGithub(st);
        if (st?.linked) {
          const r = await listGithubRepos(t);
          if (r.ok) setRepos((r.data as GithubRepo[]) ?? []);
        } else {
          setEntry('url');
        }
      }
      if (deps && !Array.isArray(deps) && deps.quota) setQuota(deps.quota);
    })();
  }, [router]);

  /** Version courte du nom : « repo » à partir de « owner/repo ». */
  function repoSlug(fullName: string): string {
    return fullName.split('/').pop() ?? fullName;
  }

  /** Pré-visualisation : dépôt vide (bloquant) puis config de build pré-remplie. */
  const loadPreview = useCallback(
    async (fullName: string, branchValue: string) => {
      const br = branchValue.trim() || 'main';
      setPreviewing(true);
      setEmptyRepo(null);
      setPreview(null);
      try {
        // Dépôt vide → message Netlify exact, on bloque (besoin du compte lié).
        if (github?.linked) {
          const empty = await checkRepoEmpty(token, fullName, br);
          if (empty.ok && (empty.data as { empty?: boolean })?.empty) {
            setEmptyRepo(`The repository ${fullName} is empty. Push code and retry.`);
            setPreviewing(false);
            return;
          }
        }
        const cfg = await previewBuildConfig(token, fullName, br);
        if (cfg.ok) {
          const c = cfg.data as BuildConfig | null;
          setPreview(c);
          if (c) {
            setBaseDirectory(c.baseDirectory ?? '');
            setBuildCommand(c.buildCommand ?? '');
            setInstallCommand(c.installCommand ?? '');
            setPublishDirectory(c.publishDirectory ?? '');
            setFunctionsDirectory(c.functionsDirectory ?? '');
            setBuildPack(
              (c.pack && (BUILD_PACKS as readonly string[]).includes(c.pack))
                ? (c.pack as BuildPack)
                : '',
            );
            setEnvRows(Object.entries(c.environment).map(([k, v]) => ({ key: k, value: v })));
          }
          toast.info('Config de build pré-remplie depuis le dépôt.');
        } else {
          setPreview({ environment: {}, source: 'none' });
        }
      } catch {
        toast.error('Impossible de pré-visualiser le dépôt.');
      } finally {
        setPreviewing(false);
      }
    },
    [github, token, toast],
  );

  function onRepoChange(fullName: string) {
    setRepoFullName(fullName);
    setAppName(repoSlug(fullName));
    const repo = repos.find((x) => x.fullName === fullName);
    const defaultBranch = repo?.defaultBranch ?? 'main';
    setBranch(defaultBranch);
    if (fullName) {
      setRepoFullName(fullName);
      void loadPreview(fullName, defaultBranch);
    } else {
      setPreview(null);
      setEmptyRepo(null);
    }
  }

  async function onDetectUrl() {
    const input = url.trim();
    if (!input) return;
    setDetecting(true);
    setEmptyRepo(null);
    setPreview(null);
    const r = await detectDeployment(token, input);
    setDetecting(false);
    if (!r.ok) return toast.error(apiError(r, 'Détection impossible.'));
    const d = r.data as DetectResult | null;
    if (!d) return toast.error('Détection impossible.');
    setDetected(d);
    if (d.repoFullName) {
      setRepoFullName(d.repoFullName);
      setAppName(repoSlug(d.repoFullName));
      setBranch(d.defaultBranch);
      setBuildPack(
        (BUILD_PACKS as readonly string[]).includes(d.suggestedBuildPack)
          ? (d.suggestedBuildPack as BuildPack)
          : '',
      );
      void loadPreview(d.repoFullName, d.defaultBranch);
    }
  }

  function addEnvRow() {
    setEnvRows((rows) => [...rows, { key: '', value: '' }]);
  }

  function setEnv(i: number, patch: Partial<EnvRow>) {
    setEnvRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function removeEnv(i: number) {
    setEnvRows((rows) => rows.filter((_, idx) => idx !== i));
  }

  async function deploy() {
    if (!repoFullName) return;
    setDeploying(true);
    const environment: Record<string, string> = {};
    for (const row of envRows) {
      const k = row.key.trim();
      if (k) environment[k] = row.value;
    }
    const r = await createDeployment(token, {
      // Un lien collé (mode URL) : envoyer `repoUrl` pour que le serveur reste en
      // mode URL (aucun compte GitHub requis) — `repoFullName` forcerait le mode
      // GitHub lié (decryptToken → « Aucun compte GitHub lié »).
      ...(detected?.repoUrl ? { repoUrl: detected.repoUrl } : { repoFullName }),
      branch: branch.trim() || 'main',
      buildPack: (buildPack || undefined) as BuildPack | undefined,
      appName: appName.trim() || undefined,
      baseDirectory: baseDirectory.trim() || undefined,
      buildCommand: buildCommand.trim() || undefined,
      installCommand: installCommand.trim() || undefined,
      publishDirectory: publishDirectory.trim() || undefined,
      functionsDirectory: functionsDirectory.trim() || undefined,
      environment: Object.keys(environment).length ? environment : undefined,
      subdomain: subdomain.trim() || undefined,
    });
    setDeploying(false);
    if (!r.ok) {
      toast.error(apiError(r, 'Déploiement impossible.'));
      return;
    }
    toast.ok('Projet créé — déploiement en cours.');
    router.push('/client');
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
            <p>Connectez-vous pour créer un nouveau projet.</p>
            <a className="btn-primary" href="/auth">Se connecter</a>
          </div>
        </div>
      </AppShell>
    );
  }

  const pack = quota?.pack ?? null;
  const quotaFull = pack?.maxApps != null && quota!.used >= pack.maxApps;
  const sourceLabel =
    preview?.source === 'codediali.toml'
      ? 'codediali.toml'
      : preview?.source === 'netlify.toml'
        ? 'netlify.toml'
        : null;

  return (
    <AppShell me={me} nav={CLIENT_NAV} tenant={{ label: 'Espace client' }}>
      <div className="wrap-lg">
        <a className="store-back" href="/client">
          <IconChevronLeft size={15} /> Retour à l’espace client
        </a>

        <div className="dash-hero">
          <div>
            <div className="hero-eyebrow">Créer un nouveau Projet</div>
            <h2>Déployez vos applications en quelques clics</h2>
            <p>
              Choisissez un dépôt de votre compte GitHub ou collez un lien, puis configurez
              le build (fichier <code>codediali.toml</code> pré-rempli quand il existe). Sans
              compte GitHub ? Utilisez simplement un lien public.
            </p>
          </div>
        </div>

        {quotaFull && (
          <div className="alert error" style={{ marginBottom: 16 }}>
            Quota d&apos;applications atteint sur le plan {pack?.name}. Supprimez une application
            ou passez à un plan supérieur pour en créer une nouvelle.
          </div>
        )}

        <Panel
          title="1 · Source du code"
          sub={
            github?.linked
              ? 'Choisissez un dépôt de votre compte GitHub, ou collez un lien public.'
              : 'Collez un lien public de dépôt GitHub (la liaison GitHub est optionnelle).'
          }
        >
          <div className="stack">
            {github?.linked && (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <Button
                  variant={entry === 'github' ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setEntry('github')}
                >
                  Dépôt de mon compte GitHub
                </Button>
                <Button
                  variant={entry === 'url' ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => {
                    setEntry('url');
                    setPreview(null);
                    setEmptyRepo(null);
                  }}
                >
                  Lien GitHub (URL)
                </Button>
              </div>
            )}

            {entry === 'github' && github?.linked ? (
              <div className="inline-form">
                <Field label="Dépôt" hint={github.linked ? 'Synchronisé avec votre compte GitHub' : undefined}>
                  <Select value={repoFullName} onChange={(e) => onRepoChange(e.target.value)}>
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
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                  />
                </Field>
              </div>
            ) : (
              <div className="stack">
                {!github?.linked && (
                  <p className="muted" style={{ fontSize: 13 }}>
                    La liaison GitHub est optionnelle — vous pouvez coller l&apos;URL de n&apos;importe
                    quel dépôt GitHub public. (<a href="/profil">Lier mon compte GitHub</a> pour
                    choisir un de mes dépôts.)
                  </p>
                )}
                <div className="inline-form">
                  <Field label="Lien du dépôt GitHub" hint="ex. https://github.com/vous/mon-projet">
                    <Input
                      className="flex-1"
                      placeholder="https://github.com/vous/mon-projet.git"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      disabled={isImp || detecting}
                    />
                  </Field>
                  <Button
                    variant="secondary"
                    disabled={isImp || detecting || !url.trim()}
                    onClick={onDetectUrl}
                  >
                    {detecting ? 'Détection…' : 'Détecter'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </Panel>

        {/* ── Dépôt vide → message Netlify exact, création bloquée ─────── */}
        {emptyRepo && (
          <div className="alert error mt" style={{ whiteSpace: 'pre-wrap' }}>
            {emptyRepo}
          </div>
        )}

        {/* ── Dépôt choisi → page de build professionnelle ─────────────── */}
        {repoFullName && !emptyRepo && (
          <Panel
            title={`2 · Build — ${repoFullName}`}
            sub={
              sourceLabel
                ? `Config pré-remplie depuis votre fichier ${sourceLabel}. Modifiable — le serveur l’applique à la création.`
                : 'Détection automatique — ajustez les commandes et variables pour votre stack.'
            }
          >
            {previewing ? (
              <EmptyState>Pré-visualisation de la configuration…</EmptyState>
            ) : (
              <div className="stack">
                {sourceLabel && (
                  <div className="muted" style={{ fontSize: 12.5 }}>
                    <IconCheck size={12} /> Source : <Badge tone="ok">{sourceLabel}</Badge>
                  </div>
                )}

                <div className="stack" style={{ padding: '14px 16px', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--card-bg-2)' }}>
                  <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
                    <Field label="Nom de l’application">
                      <Input className="input-sm" value={appName} onChange={(e) => setAppName(e.target.value)} />
                    </Field>
                    <Field label="Build pack" hint="Pré-rempli si connu, modifiable.">
                      <Select value={buildPack} onChange={(e) => setBuildPack(e.target.value as BuildPack)}>
                        <option value="">Auto</option>
                        {BUILD_PACKS.map((b) => (
                          <option key={b} value={b}>{b}</option>
                        ))}
                      </Select>
                    </Field>
                  </div>

                  <Field label="Base directory" hint="Sous-dossier racine du build (monorepo). Vide = racine.">
                    <Input className="input-sm" placeholder="frontend/" value={baseDirectory} onChange={(e) => setBaseDirectory(e.target.value)} />
                  </Field>

                  <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
                    <Field label="Build command" hint="Commande de build (ex. npm run build).">
                      <Input className="input-sm" placeholder="npm run build" value={buildCommand} onChange={(e) => setBuildCommand(e.target.value)} />
                    </Field>
                    <Field label="Install command" hint="Installation des dépendances (optionnel).">
                      <Input className="input-sm" placeholder="npm install --frozen-lockfile" value={installCommand} onChange={(e) => setInstallCommand(e.target.value)} />
                    </Field>
                  </div>

                  <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
                    <Field label="Publish directory" hint="Dossier servit (sortie de build / statique).">
                      <Input className="input-sm" placeholder="dist" value={publishDirectory} onChange={(e) => setPublishDirectory(e.target.value)} />
                    </Field>
                    <Field label="Functions directory" hint="Dossier de fonctions (best-effort, optionnel).">
                      <Input className="input-sm" placeholder="functions" value={functionsDirectory} onChange={(e) => setFunctionsDirectory(e.target.value)} />
                    </Field>
                  </div>

                  <Field label="Sous-domaine (optionnel)" hint="Libre ; vide = slug auto. Vous obtenez une URL en https://.">
                    <Input className="input-sm" placeholder="mon-app" value={subdomain} onChange={(e) => setSubdomain(e.target.value)} />
                  </Field>

                  {/* Variables d'environnement de build */}
                  <div>
                    <div className="section-title" style={{ marginBottom: 4 }}>
                      <h3>Variables d’environnement (build)</h3>
                      <span className="muted" style={{ fontSize: 12 }}>
                        <IconCopy size={12} /> Injectées au build, jamais exposées.
                      </span>
                    </div>
                    {envRows.length === 0 ? (
                      <EmptyState>Aucune variable. Ajoutez-en si votre build en nécessite.</EmptyState>
                    ) : (
                      <div className="stack">
                        {envRows.map((row, i) => (
                          <div key={i} className="inline-form">
                            <Input
                              className="input-sm"
                              placeholder="CLÉ"
                              value={row.key}
                              onChange={(e) => setEnv(i, { key: e.target.value })}
                              autoComplete="off"
                              spellCheck={false}
                            />
                            <Input
                              className="flex-1 input-sm"
                              placeholder="valeur"
                              value={row.value}
                              onChange={(e) => setEnv(i, { value: e.target.value })}
                              autoComplete="off"
                              spellCheck={false}
                            />
                            <Button variant="ghost" size="sm" onClick={() => removeEnv(i)} aria-label="Supprimer">
                              <IconTrash />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      className="btn-secondary btn-sm mt"
                      onClick={addEnvRow}
                      style={{ marginTop: 8 }}
                    >
                      <IconPlus /> Ajouter une variable
                    </button>
                  </div>
                </div>

                <div className="row" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    {quota
                      ? `${quota.used} app(s) utilisée(s)${pack?.maxApps ? ` / ${pack.maxApps}` : ''} sur le plan ${pack?.name}.`
                      : 'Serveur et infrastructure pilotés par la plateforme.'}
                  </span>
                  <Button
                    onClick={deploy}
                    disabled={isImp || deploying || quotaFull}
                  >
                    <IconPlus /> {deploying ? 'Déploiement…' : 'Déployer'}
                  </Button>
                </div>
              </div>
            )}
          </Panel>
        )}
      </div>
    </AppShell>
  );
}