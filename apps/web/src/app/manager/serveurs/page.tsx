'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  apiError,
  checkServer,
  createServer,
  deleteServer,
  listServers,
  ServerAdmin,
  ServerCheckResult,
  ServerPanelVerifyResult,
  ServerPatch,
  updateServer,
  verifyServerPanel,
} from '@/lib/api';
import { useAdminSession } from '@/lib/session';
import { useToast } from '@/components/toast';
import { AppShell } from '@/components/app-shell';
import { ADMIN_NAV } from '@/config/nav';
import {
  Badge,
  Button,
  Denied,
  EmptyState,
  Field,
  Input,
  PageIntro,
  PageLoading,
  Select,
} from '@/components/ui';
import {
  IconCheck,
  IconGlobe,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconServer,
  IconTrash,
  IconX,
} from '@/components/icons';

const SERVER_STATUSES = ['UNKNOWN', 'PROVISIONING', 'ACTIVE', 'PROBLEM', 'REMOVED'];
const PANEL_PROVIDERS = [
  { value: 'NONE', label: '— Aucun' },
  { value: 'HESTIA', label: 'Hestia' },
  { value: 'COOLIFY', label: 'Coolify' },
];
// cPanel / DirectAdmin / autres s'ajouteront dans ce sélect quand leurs connecteurs seront prêts.

function statusTone(status: string): 'ok' | 'warn' | 'danger' | 'neutral' {
  switch (status) {
    case 'ACTIVE':
      return 'ok';
    case 'PROVISIONING':
      return 'warn';
    case 'PROBLEM':
      return 'danger';
    default:
      return 'neutral';
  }
}

function panelTone(p: string): 'violet' | 'cyan' | 'neutral' {
  switch (p) {
    case 'HESTIA':
      return 'violet';
    case 'COOLIFY':
      return 'cyan';
    default:
      return 'neutral';
  }
}

function panelLabel(p: string): string {
  return PANEL_PROVIDERS.find((x) => x.value === p)?.label?.replace('— ', '') ?? '—';
}

/** Teinte de l'icône de la carte selon le statut (ok=vert, problème=rouge, sinon bleu). */
function cardTone(status: string): 'ok' | 'problem' | '' {
  if (status === 'ACTIVE') return 'ok';
  if (status === 'PROBLEM') return 'problem';
  return '';
}

/** Format RAM lisible (Mo → Go au-delà de 1024). */
function fmtRam(mb?: number | null): string {
  if (mb == null) return '—';
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} Go`;
  return `${mb} Mo`;
}

/** Format disque lisible (Go). */
function fmtDisk(gb?: number | null): string {
  return gb != null ? `${gb} Go` : '—';
}

/**
 * URL d'accès rapide au serveur (Phase 9bis) : priorité à l'origine dérivée de
 * apiBaseUrl (adresse réelle du panneau, port compris), sinon hostname en https.
 */
function hostHref(s: ServerAdmin): string | null {
  if (s.apiBaseUrl) {
    try {
      return new URL(s.apiBaseUrl).origin;
    } catch {
      /* URL malformée — bascule sur le hostname */
    }
  }
  if (s.hostname) return `https://${s.hostname}`;
  return null;
}

/** Label court affiché pour le lien « Ouvrir » (ou '.' s'il manque hostname). */
function hostLabel(s: ServerAdmin): string {
  return s.hostname || '—';
}

/** Valeurs initiales vides pour une création ou pour remettre une édition à blanc. */
function emptyDraft() {
  return {
    name: '',
    hostname: '',
    status: 'UNKNOWN' as string,
    ipAddress: '',
    port: '',
    provider: '',
    region: '',
    quotaMaxAccounts: '',
    strictTls: true,
    panelProvider: 'NONE' as string,
    // Phase 9 (ADR-010) : config API panneau. Le jeton entré ici est un secret
    // ENTRANT (jamais réaffiché) ; `hasApiToken` reflète l'état persisté (édition).
    apiBaseUrl: '',
    apiUser: '',
    apiToken: '',
    hasApiToken: false,
    // Métriques (Phase 9bis) — auto-détectées via le panneau (Hestia sysinfo),
    // sinon saisies manuellement ici.
    ramMb: '',
    cpuCores: '',
    diskGb: '',
    bandwidthLimit: '',
  };
}

type Draft = ReturnType<typeof emptyDraft>;

/** Panneau latéral : création d'un serveur ou édition d'un existant. */
type DrawerState = { kind: 'create' } | { kind: 'edit'; id: string } | null;

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function ManagerServeursPage() {
  const { phase, me, token } = useAdminSession();
  const toast = useToast();
  const [servers, setServers] = useState<ServerAdmin[]>([]);
  // recherche + filtre par statut (mémoire — aucun appel API supplémentaire)
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  // panneau latéral (création / édition) + brouillon unique
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [busy, setBusy] = useState<string | null>(null); // 'create' | server id
  // Phase 8 : sonde de connexion — id en cours de test + derniers résultats (par serveur).
  const [checking, setChecking] = useState<string | null>(null);
  const [probeMap, setProbeMap] = useState<Record<string, ServerCheckResult>>({});
  // Phase 9 : vérification API du panneau — id en cours + derniers résultats.
  const [verifying, setVerifying] = useState<string | null>(null);
  const [panelMap, setPanelMap] = useState<Record<string, ServerPanelVerifyResult['result']>>({});

  useEffect(() => {
    if (phase === 'ready' && token) void load(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, token]);

  // Échap ferme le panneau latéral (tant qu'aucune requête n'est en cours).
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && busy === null) setDrawer(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer, busy]);

  async function load(t: string) {
    const r = await listServers(t);
    if (!r.ok) return toast.error(apiError(r, 'Impossible de charger les serveurs.'));
    setServers((r.data as ServerAdmin[]) ?? []);
  }

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  /** convertit un brouillon en PATCH serveur (vide → null, nombres validés). */
  function toPatch(d: Draft): ServerPatch {
    const port = d.port === '' ? null : Number(d.port);
    const quota = d.quotaMaxAccounts === '' ? null : Number(d.quotaMaxAccounts);
    const metric = (v: string | number): number | null => {
      const n = Number(v);
      return v === '' || !Number.isFinite(n) ? null : n;
    };
    return {
      name: d.name || undefined,
      hostname: d.hostname || undefined,
      status: d.status || undefined,
      ipAddress: d.ipAddress === '' ? null : d.ipAddress,
      port: Number.isFinite(port) ? port : null,
      provider: d.provider === '' ? null : d.provider,
      region: d.region === '' ? null : d.region,
      quotaMaxAccounts: Number.isFinite(quota) ? quota : null,
      strictTls: d.strictTls,
      panelProvider: d.panelProvider as ServerPatch['panelProvider'],
      // Phase 9 : URL/user vides → effacés ; jeton vide = inchangé (sécurité).
      apiBaseUrl: d.apiBaseUrl === '' ? null : d.apiBaseUrl,
      apiUser: d.apiUser === '' ? null : d.apiUser,
      apiToken: d.apiToken === '' ? undefined : d.apiToken,
      // Métriques (Phase 9bis) : '' → null ; bande passante = label libre.
      ramMb: metric(d.ramMb),
      cpuCores: metric(d.cpuCores),
      diskGb: metric(d.diskGb),
      bandwidthLimit: d.bandwidthLimit === '' ? null : d.bandwidthLimit,
    };
  }

  function openCreate() {
    setDraft(emptyDraft());
    setDrawer({ kind: 'create' });
  }

  function startEdit(s: ServerAdmin) {
    setDraft({
      name: s.name,
      hostname: s.hostname,
      status: s.status,
      ipAddress: s.ipAddress ?? '',
      port: s.port?.toString() ?? '',
      provider: s.provider ?? '',
      region: s.region ?? '',
      quotaMaxAccounts: s.quotaMaxAccounts?.toString() ?? '',
      strictTls: s.strictTls,
      panelProvider: s.panelProvider ?? 'NONE',
      apiBaseUrl: s.apiBaseUrl ?? '',
      apiUser: s.apiUser ?? '',
      apiToken: '', // jamais réaffiché — vide = conserve le jeton actuel
      hasApiToken: s.hasApiToken,
      ramMb: s.ramMb?.toString() ?? '',
      cpuCores: s.cpuCores?.toString() ?? '',
      diskGb: s.diskGb?.toString() ?? '',
      bandwidthLimit: s.bandwidthLimit ?? '',
    });
    setDrawer({ kind: 'edit', id: s.id });
  }

  async function handleCreate() {
    if (!draft.name.trim() || !draft.hostname.trim()) {
      return toast.error('Le nom et le hostname sont obligatoires.');
    }
    setBusy('create');
    const r = await createServer(token, {
      name: draft.name.trim(),
      hostname: draft.hostname.trim(),
      ...toPatch(draft),
    });
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de la création du serveur.'));
    toast.ok('Serveur créé.');
    setDrawer(null);
    setDraft(emptyDraft());
    void load(token);
  }

  async function saveEdit(id: string, d: Draft) {
    const patch = toPatch(d);
    if (!patch.name || !patch.hostname) return toast.error('Le nom et le hostname sont obligatoires.');
    setBusy(id);
    const r = await updateServer(token, id, patch);
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de l’enregistrement du serveur.'));
    toast.ok('Serveur mis à jour.');
    setDrawer(null);
    void load(token);
  }

  /** Soumet le panneau latéral selon son mode (création ou édition). */
  function submitDrawer() {
    if (!drawer || busy) return;
    if (drawer.kind === 'create') return void handleCreate();
    return void saveEdit(drawer.id, draft);
  }

  async function handleCheck(s: ServerAdmin) {
    if (checking) return;
    setChecking(s.id);
    const r = await checkServer(token, s.id);
    setChecking(null);
    if (!r.ok) return toast.error(apiError(r, 'Impossible de tester la connexion.'));
    const res = r.data as ServerCheckResult;
    if (!res?.probe) return toast.error('Réponse inattendue du test de connexion.');
    setProbeMap((m) => ({ ...m, [s.id]: res }));
    if (res.probe.ok) toast.ok(`Connexion OK — ${res.probe.detail}`);
    else toast.error(`Connexion en échec — ${res.probe.detail}`);
  }

  /** Phase 9 (ADR-010) : sonde l'API du panneau (Hestia/Coolify) sur ce serveur. */
  async function handlePanelVerify(s: ServerAdmin) {
    if (verifying) return;
    setVerifying(s.id);
    const r = await verifyServerPanel(token, s.id);
    setVerifying(null);
    if (!r.ok) return toast.error(apiError(r, 'Impossible de vérifier l’API du panneau.'));
    const res = r.data as ServerPanelVerifyResult;
    if (!res?.result) return toast.error('Réponse inattendue de la vérification.');
    setPanelMap((m) => ({ ...m, [s.id]: res.result }));
    void load(token); // rappatrie l'état persisté (panelVerifiedAt/panelDetail)
    if (res.result.ok) toast.ok(`API du panneau OK — ${res.result.detail}`);
    else toast.error(`API du panneau en échec — ${res.result.detail}`);
  }

  /** Bascule rapide du statut validée par l'admin, alignée sur le résultat de la sonde. */
  async function applyStatusQuick(s: ServerAdmin, status: string) {
    setBusy(s.id);
    const r = await updateServer(token, s.id, { status });
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec du changement de statut.'));
    toast.ok(`Statut basculé en ${status}.`);
    void load(token);
  }

  /** Badge d'état de connexion persisté (ok / échec / jamais testé). */
  function connTone(s: ServerAdmin): 'ok' | 'danger' | 'neutral' {
    if (s.lastProbeOk === true) return 'ok';
    if (s.lastProbeOk === false) return 'danger';
    return 'neutral';
  }
  function connLabel(s: ServerAdmin): string {
    if (s.lastProbeOk === true) return 'OK';
    if (s.lastProbeOk === false) return 'Échec';
    return '—';
  }

  /** Badge d'état de vérification de l'API panneau (résultat frais > persisté). */
  function panelResult(s: ServerAdmin): { ok: boolean; detail: string } | null {
    const fresh = panelMap[s.id];
    if (fresh) return { ok: fresh.ok, detail: fresh.detail };
    if (s.panelOk != null) return { ok: s.panelOk, detail: s.panelDetail ?? '—' };
    return null;
  }
  function panelVerifyTone(pv: { ok: boolean } | null): 'ok' | 'danger' | 'neutral' {
    if (pv?.ok === true) return 'ok';
    if (pv?.ok === false) return 'danger';
    return 'neutral';
  }
  function panelVerifyLabel(pv: { ok: boolean } | null): string {
    if (pv?.ok === true) return 'API OK';
    if (pv?.ok === false) return 'Échec';
    return '—';
  }
  /** Astuce de configuration selon le panneau sélectionné (drawer). */
  function panelApiHint(p: string): string {
    if (p === 'HESTIA')
      return 'Hestia : utilisateur « api » + clé d’accès, URL du endpoint API (ex. https://host:8083/api/).';
    if (p === 'COOLIFY')
      return 'Coolify : jeton d’accès (Bearer), URL de l’API (ex. https://panel.exemple.com/api/v1).';
    return '';
  }

  async function handleDelete(s: ServerAdmin) {
    if (!window.confirm(`Supprimer le serveur « ${s.name} » ?`)) return;
    setBusy(s.id);
    const r = await deleteServer(token, s.id);
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de la suppression.'));
    toast.ok('Serveur supprimé.');
    void load(token);
  }

  // Compteurs par statut (chips filtres) + liste filtrée pour la grille.
  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: servers.length };
    for (const s of servers) c[s.status] = (c[s.status] ?? 0) + 1;
    return c;
  }, [servers]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return servers.filter((s) => {
      if (statusFilter !== 'ALL' && s.status !== statusFilter) return false;
      if (!needle) return true;
      const hay = [s.name, s.hostname, s.ipAddress ?? '', s.provider ?? '', s.region ?? '']
        .join(' ')
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [servers, q, statusFilter]);

  if (phase === 'loading') {
    return (
      <AppShell me={null} nav={ADMIN_NAV}>
        <PageLoading />
      </AppShell>
    );
  }

  if (phase === 'denied') {
    return (
      <AppShell me={null} nav={ADMIN_NAV}>
        <Denied />
      </AppShell>
    );
  }

  const editing = drawer?.kind === 'edit' ? servers.find((s) => s.id === drawer.id) : null;
  const drawerTitle = drawer ? (drawer.kind === 'create' ? 'Nouveau serveur' : `Modifier « ${editing?.name ?? ''} »`) : '';

  return (
    <AppShell me={me} nav={ADMIN_NAV} tenant={{ label: 'Administration' }}>
      <div className="wrap-md">
        <PageIntro
          eyebrow="Administration"
          title="Serveurs (infrastructure)"
          sub="Registre des hôtes de la plateforme. La fiche s’enrichira automatiquement quand la connexion réelle des serveurs sera établie (statut, charge, panneau de gestion)."
        >
          <Button onClick={openCreate}>
            <IconPlus size={14} />
            Nouveau serveur
          </Button>
        </PageIntro>

        {servers.length === 0 ? (
          <EmptyState>
            <IconServer />
            <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Aucun serveur enregistré</div>
            <div className="muted" style={{ fontSize: 13.5 }}>
              Ajoutez votre premier hôte via « Nouveau serveur ».
            </div>
            <div style={{ marginTop: 14 }}>
              <Button onClick={openCreate}>
                <IconPlus size={14} />
                Nouveau serveur
              </Button>
            </div>
          </EmptyState>
        ) : (
          <>
            <div className="srv-toolbar">
              <div className="srv-search">
                <IconSearch />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Rechercher (nom, hostname, IP, fournisseur…)"
                  aria-label="Rechercher un serveur"
                />
              </div>
              <div className="srv-chips">
                {['ALL', ...SERVER_STATUSES].map((st) => (
                  <button
                    key={st}
                    type="button"
                    className={`srv-chip${statusFilter === st ? ' active' : ''}`}
                    onClick={() => setStatusFilter(st)}
                  >
                    {st === 'ALL' ? 'Tous' : st}
                    <span className="n">{counts[st] ?? 0}</span>
                  </button>
                ))}
              </div>
              <div className="srv-count">
                {visible.length} affiché{visible.length > 1 ? 's' : ''} / {servers.length}
              </div>
            </div>

            {visible.length === 0 ? (
              <EmptyState>
                <IconSearch />
                <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                  Aucun serveur ne correspond à votre recherche
                </div>
                <div className="muted" style={{ fontSize: 13.5 }}>
                  Modifiez la recherche ou le filtre de statut.
                </div>
              </EmptyState>
            ) : (
              <div className="srv-grid">
                {visible.map((s) => {
                  // Résultat : fraîchement testé (cette session) ou dernier résultat persisté.
                  const probe =
                    probeMap[s.id]?.probe ??
                    (s.lastProbeOk != null
                      ? { ok: s.lastProbeOk, detail: s.lastProbeDetail ?? '—' }
                      : null);
                  // Phase 9 : statut de l'API panneau (résultat frais > persisté).
                  const pv = panelResult(s);
                  const p = s.panelProvider ?? 'NONE';
                  return (
                    <div key={s.id} className="srv-card">
                      <div className="srv-card-head">
                        <div className={`srv-card-ico ${cardTone(s.status)}`}>
                          <IconServer />
                        </div>
                        <div className="srv-card-titles">
                          <div className="srv-card-title">
                            <span>{s.name}</span>
                            <Badge tone={statusTone(s.status)}>{s.status}</Badge>
                          </div>
                          <div className="srv-card-sub">{s.hostname}</div>
                        </div>
                      </div>

                      <div className="srv-card-body">
                        <div className="srv-field">
                          <dt>IP</dt>
                          <dd className="mono">{s.ipAddress ?? '—'}</dd>
                        </div>
                        <div className="srv-field">
                          <dt>Port</dt>
                          <dd className="mono">{s.port ?? '—'}</dd>
                        </div>
                        <div className="srv-field">
                          <dt>Fournisseur</dt>
                          <dd>{s.provider ?? '—'}</dd>
                        </div>
                        <div className="srv-field">
                          <dt>Région</dt>
                          <dd>{s.region ?? '—'}</dd>
                        </div>
                        <div className="srv-field">
                          <dt>Quota comptes</dt>
                          <dd>{s.quotaMaxAccounts != null ? `${s.quotaMaxAccounts}` : '—'}</dd>
                        </div>
                        <div className="srv-field">
                          <dt>TLS</dt>
                          <dd>
                            <Badge tone={s.strictTls ? 'ok' : 'warn'}>
                              {s.strictTls ? 'Strict' : 'Off'}
                            </Badge>
                          </dd>
                        </div>
                        {/* Métriques annoncées (Phase 9bis) — auto ou manuelles, « — » si inconnu. */}
                        <div className="srv-field">
                          <dt>RAM</dt>
                          <dd>{fmtRam(s.ramMb)}</dd>
                        </div>
                        <div className="srv-field">
                          <dt>CPU</dt>
                          <dd>{s.cpuCores != null ? `${s.cpuCores} cœurs` : '—'}</dd>
                        </div>
                        <div className="srv-field">
                          <dt>Disque</dt>
                          <dd>{fmtDisk(s.diskGb)}</dd>
                        </div>
                        <div className="srv-field">
                          <dt>Bande passante</dt>
                          <dd>{s.bandwidthLimit ?? '—'}</dd>
                        </div>
                        <div className="srv-field srv-field-full">
                          <dt>Panneau</dt>
                          <dd>
                            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                              <Badge tone={panelTone(p)}>{panelLabel(p)}</Badge>
                              {p !== 'NONE' && (
                                <Badge tone={panelVerifyTone(pv)}>
                                  <span className="dot" />
                                  {panelVerifyLabel(pv)}
                                </Badge>
                              )}
                              {p !== 'NONE' && (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={verifying === s.id || busy === s.id}
                                  onClick={() => handlePanelVerify(s)}
                                  title="Tester l’API réelle du panneau serveur (nécessite URL + jeton configurés)"
                                >
                                  {verifying === s.id ? (
                                    <span style={{ opacity: 0.6 }}>Test…</span>
                                  ) : (
                                    <IconRefresh size={13} />
                                  )}
                                  Vérifier l’API
                                </Button>
                              )}
                            </div>
                            {p !== 'NONE' && (
                              <div className="muted" style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.55 }}>
                                {pv ? pv.detail : 'Jamais vérifié'}
                                {s.panelVerifiedAt && (
                                  <div>Vérifié : {fmtDate(s.panelVerifiedAt)}</div>
                                )}
                                {!s.hasApiToken && (
                                  <div>Aucun jeton API configuré — complétez la fiche puis réessayez.</div>
                                )}
                              </div>
                            )}
                          </dd>
                        </div>
                        <div className="srv-field srv-field-full">
                          <dt>API panneau</dt>
                          <dd>
                            {s.apiBaseUrl ? (
                              <a
                                href={hostHref(s) ?? '#'}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="srv-link"
                                title={s.apiBaseUrl}
                              >
                                {s.apiBaseUrl}
                              </a>
                            ) : (
                              '—'
                            )}
                          </dd>
                        </div>

                        <div className="srv-conn">
                          <Badge tone={connTone(s)}>
                            <span className="dot" />
                            {connLabel(s)}
                          </Badge>
                          <div className="srv-conn-main">
                            <div className="srv-conn-detail">
                              {probe ? probe.detail : 'Jamais testé'}
                              {s.lastCheckedAt && (
                                <div>Dernier test : {fmtDate(s.lastCheckedAt)}</div>
                              )}
                              {probe && (
                                <div className="srv-conn-quick">
                                  {probe.ok ? (
                                    <Button
                                      size="sm"
                                      disabled={busy === s.id || s.status === 'ACTIVE'}
                                      onClick={() => applyStatusQuick(s, 'ACTIVE')}
                                      title="Valider le statut en cohérence avec la connexion OK"
                                    >
                                      → ACTIVE
                                    </Button>
                                  ) : (
                                    <Button
                                      size="sm"
                                      variant="danger"
                                      disabled={busy === s.id || s.status === 'PROBLEM'}
                                      onClick={() => applyStatusQuick(s, 'PROBLEM')}
                                      title="Signaler le serveur en problème (connexion en échec)"
                                    >
                                      → PROBLEM
                                    </Button>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant={s.lastProbeOk === false ? 'danger' : 'secondary'}
                            disabled={checking === s.id}
                            onClick={() => handleCheck(s)}
                            title="Tester la connexion réelle"
                          >
                            {checking === s.id ? (
                              <span style={{ opacity: 0.6 }}>Test…</span>
                            ) : (
                              <IconRefresh size={13} />
                            )}
                            Tester
                          </Button>
                        </div>
                      </div>

                      <div className="srv-card-foot">
                        <div className="srv-actions row" style={{ gap: 8 }}>
                          {hostHref(s) ? (
                            <a
                              className="btn-primary btn-sm"
                              href={hostHref(s) as string}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={`Ouvrir ${hostHref(s)}`}
                            >
                              <IconGlobe size={13} />
                              Ouvrir
                            </a>
                          ) : null}
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy === s.id}
                            onClick={() => startEdit(s)}
                            title="Modifier le serveur"
                          >
                            <IconPencil size={13} />
                            Modifier
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={busy === s.id}
                            onClick={() => handleDelete(s)}
                            title="Supprimer le serveur"
                          >
                            <IconTrash size={13} />
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* Panneau latéral de création / édition */}
      {drawer && (
        <div
          className="drawer-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget && busy === null) setDrawer(null);
          }}
        >
          <div className="drawer" role="dialog" aria-modal="true" aria-label={drawerTitle}>
            <div className="drawer-head">
              <div className="flex-1">
                <div className="drawer-title">{drawerTitle}</div>
                <div className="drawer-sub">
                  {drawer.kind === 'create'
                    ? 'Ajouter un hôte à l’infrastructure — tous les champs au-delà du nom/hostname sont optionnels.'
                    : 'Tous les champs au-delà du nom/hostname restent optionnels.'}
                </div>
              </div>
              <Button
                variant="secondary"
                className="drawer-close"
                disabled={busy !== null}
                onClick={() => setDrawer(null)}
                title="Fermer"
                aria-label="Fermer"
              >
                <IconX size={15} />
              </Button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submitDrawer();
              }}
            >
              <div className="drawer-body">
                <div className="grid-form">
                  <Field label="Nom" required>
                    <Input value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="prod-01" />
                  </Field>
                  <Field label="Hostname" required>
                    <Input value={draft.hostname} onChange={(e) => set('hostname', e.target.value)} placeholder="node1.exemple.com" />
                  </Field>
                  <Field label="Adresse IP">
                    <Input value={draft.ipAddress} onChange={(e) => set('ipAddress', e.target.value)} placeholder="198.51.100.7" />
                  </Field>
                  <Field label="Port">
                    <Input type="number" min={1} max={65535} value={draft.port} onChange={(e) => set('port', e.target.value)} placeholder="22" />
                  </Field>
                  <Field label="Fournisseur">
                    <Input value={draft.provider} onChange={(e) => set('provider', e.target.value)} placeholder="Hetzner, OVH…" />
                  </Field>
                  <Field label="Région / localisation">
                    <Input value={draft.region} onChange={(e) => set('region', e.target.value)} placeholder="fra1, paris…" />
                  </Field>
                  <Field label="Quota max comptes hébergés">
                    <Input type="number" min={0} value={draft.quotaMaxAccounts} onChange={(e) => set('quotaMaxAccounts', e.target.value)} placeholder="20" />
                  </Field>
                  <Field label="Panneau serveur">
                    <Select value={draft.panelProvider} onChange={(e) => set('panelProvider', e.target.value)}>
                      {PANEL_PROVIDERS.map((p) => (
                        <option key={p.value} value={p.value}>{p.label}</option>
                      ))}
                    </Select>
                  </Field>
                  {panelApiHint(draft.panelProvider) && (
                    <div className="srv-field-full">
                      <span className="muted cell-sub" style={{ lineHeight: 1.6 }}>
                        {panelApiHint(draft.panelProvider)}
                      </span>
                    </div>
                  )}
                  {draft.panelProvider !== 'NONE' && (
                    <>
                      <Field label="URL API du panneau">
                        <Input
                          value={draft.apiBaseUrl}
                          onChange={(e) => set('apiBaseUrl', e.target.value)}
                          placeholder="https://panel.exemple.com/api/v1"
                        />
                      </Field>
                      <Field label="Utilisateur API">
                        <Input
                          value={draft.apiUser}
                          onChange={(e) => set('apiUser', e.target.value)}
                          placeholder={draft.panelProvider === 'HESTIA' ? 'api' : '—'}
                        />
                      </Field>
                      <Field label={draft.panelProvider === 'HESTIA' ? 'Clé d’accès (jeton)' : 'Jeton d’accès API'}>
                        <Input
                          type="password"
                          autoComplete="new-password"
                          value={draft.apiToken}
                          onChange={(e) => set('apiToken', e.target.value)}
                          placeholder={
                            draft.hasApiToken
                              ? '•••••••• (laisser vide pour conserver)'
                              : 'secret-token'
                          }
                        />
                      </Field>
                      {draft.hasApiToken && (
                        <div className="srv-field-full">
                          <span className="muted cell-sub" style={{ lineHeight: 1.6 }}>
                            Un jeton API est déjà configuré pour ce serveur. Laissez le champ vide pour le
                            conserver ; une nouvelle saisie le remplace.
                          </span>
                        </div>
                      )}
                    </>
                  )}
                  <div className="srv-field-full">
                    <span className="muted cell-sub" style={{ lineHeight: 1.6 }}>
                      <b>Métriques du serveur</b> — renseignées automatiquement si le panneau Hestia les
                      expose à la vérification ; sinon, saisissez-les ci-dessous (laissez vide si inconnu).
                    </span>
                  </div>
                  <Field label="RAM (Mo)">
                    <Input type="number" min={1} value={draft.ramMb} onChange={(e) => set('ramMb', e.target.value)} placeholder="8192" />
                  </Field>
                  <Field label="CPU (cœurs)">
                    <Input type="number" min={1} max={1024} value={draft.cpuCores} onChange={(e) => set('cpuCores', e.target.value)} placeholder="4" />
                  </Field>
                  <Field label="Disque (Go)">
                    <Input type="number" min={1} value={draft.diskGb} onChange={(e) => set('diskGb', e.target.value)} placeholder="200" />
                  </Field>
                  <Field label="Limite bande passante">
                    <Input value={draft.bandwidthLimit} onChange={(e) => set('bandwidthLimit', e.target.value)} placeholder="2 To / mois" />
                  </Field>
                  <div className="field">
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={draft.strictTls}
                        onChange={(e) => set('strictTls', e.target.checked)}
                      />
                      Vérifier strictement les certificats SSL/TLS sur les requêtes API du serveur
                    </label>
                  </div>
                  {drawer.kind === 'edit' && (
                    <Field label="Statut">
                      <Select value={draft.status} onChange={(e) => set('status', e.target.value)}>
                        {SERVER_STATUSES.map((st) => (
                          <option key={st} value={st}>{st}</option>
                        ))}
                      </Select>
                    </Field>
                  )}
                  {drawer.kind === 'create' && (
                    <div className="field">
                      <span className="muted cell-sub" style={{ lineHeight: 1.6 }}>
                        Statut initial : <b>UNKNOWN</b>. Les statuts PROVISIONING/ACTIVE/PROBLEM seront pilotés par la connexion réelle au serveur (à venir).
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <div className="drawer-foot">
                <Button
                  variant="secondary"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => setDrawer(null)}
                >
                  Annuler
                </Button>
                <Button type="submit" disabled={busy !== null}>
                  {busy
                    ? drawer.kind === 'create'
                      ? 'Création…'
                      : 'Enregistrement…'
                    : drawer.kind === 'create'
                      ? 'Créer le serveur'
                      : 'Enregistrer'}
                  {!busy && drawer.kind === 'edit' && <IconCheck size={14} />}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AppShell>
  );
}
