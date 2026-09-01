'use client';

import { useEffect, useState } from 'react';
import {
  apiError,
  createServer,
  deleteServer,
  listServers,
  ServerAdmin,
  ServerPatch,
  updateServer,
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
  Panel,
  Select,
} from '@/components/ui';
import { IconCheck, IconPlus, IconServer, IconX } from '@/components/icons';

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
  };
}

type Draft = ReturnType<typeof emptyDraft>;

export default function ManagerServeursPage() {
  const { phase, me, token } = useAdminSession();
  const toast = useToast();
  const [servers, setServers] = useState<ServerAdmin[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  // édition inline : id en cours d'édition + brouillon de la ligne
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<string | null>(null); // 'create' | server id

  useEffect(() => {
    if (phase === 'ready' && token) void load(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, token]);

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
    };
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
    setShowCreate(false);
    setDraft(emptyDraft());
    void load(token);
  }

  function startEdit(s: ServerAdmin) {
    setEditingId(s.id);
    setEdit((prev) => ({
      ...prev,
      [s.id]: {
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
      },
    }));
  }

  function setEditField<K extends keyof Draft>(id: string, key: K, value: Draft[K]) {
    setEdit((prev) => ({ ...prev, [id]: { ...(prev[id] ?? emptyDraft()), [key]: value } }));
  }

  async function saveEdit(id: string, d: Draft) {
    const patch = toPatch(d);
    if (!patch.name || !patch.hostname) return toast.error('Le nom et le hostname sont obligatoires.');
    setBusy(id);
    const r = await updateServer(token, id, patch);
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de l’enregistrement du serveur.'));
    toast.ok('Serveur mis à jour.');
    setEditingId(null);
    void load(token);
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

  const ed = (id: string): Draft => edit[id] ?? emptyDraft();

  return (
    <AppShell me={me} nav={ADMIN_NAV} tenant={{ label: 'Administration' }}>
      <div className="wrap-md">
        <PageIntro
          eyebrow="Administration"
          title="Serveurs (infrastructure)"
          sub="Registre des hôtes de la plateforme. La fiche s’enrichira automatiquement quand la connexion réelle des serveurs sera établie (statut, charge, panneau de gestion)."
        >
          <Button onClick={() => setShowCreate((v) => !v)}>
            <IconPlus size={14} />
            {showCreate ? 'Fermer le formulaire' : 'Nouveau serveur'}
          </Button>
        </PageIntro>

        {showCreate && (
          <Panel
            title="Nouveau serveur"
            sub="Ajouter un hôte à l’infrastructure — tous les champs au-delà du nom/hostname sont optionnels."
            className="mb"
          >
            <form
              className="grid-form"
              onSubmit={(e) => {
                e.preventDefault();
                void handleCreate();
              }}
            >
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
              <div className="field">
                <label></label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={draft.strictTls}
                    onChange={(e) => set('strictTls', e.target.checked)}
                  />
                  Vérifier strictement les certificats SSL/TLS sur les requêtes API du serveur
                </label>
              </div>
              <div className="field">
                <span className="muted cell-sub" style={{ lineHeight: 1.6 }}>
                  Statut initial : <b>UNKNOWN</b>. Les statuts PROVISIONING/ACTIVE/PROBLEM seront pilotés par la connexion réelle au serveur (à venir).
                </span>
              </div>
              <div className="grid-form-actions">
                <Button type="submit" disabled={busy === 'create'}>
                  <IconServer size={14} />
                  {busy === 'create' ? 'Création…' : 'Créer le serveur'}
                </Button>
                <Button variant="secondary" onClick={() => setShowCreate(false)}>
                  Annuler
                </Button>
              </div>
            </form>
          </Panel>
        )}

        {servers.length === 0 ? (
          <EmptyState>
            <IconServer />
            <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Aucun serveur enregistré</div>
            <div className="muted" style={{ fontSize: 13.5 }}>
              Ajoutez votre premier hôte via « Nouveau serveur ».
            </div>
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table table-wide">
              <thead>
                <tr>
                  <th>Serveur</th>
                  <th>IP</th>
                  <th>Port</th>
                  <th>Fournisseur</th>
                  <th>Région</th>
                  <th>Quota</th>
                  <th>TLS</th>
                  <th>Panneau</th>
                  <th>Statut</th>
                  <th className="ta-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {servers.map((s) => {
                  const isEditing = editingId === s.id;
                  const d = ed(s.id);
                  return (
                    <tr key={s.id} className={isEditing ? 'row-editing' : ''}>
                      <td>
                        {isEditing ? (
                          <div className="stack">
                            <Input className="input-sm" value={d.name} onChange={(e) => setEditField(s.id, 'name', e.target.value)} aria-label="nom" />
                            <Input className="input-sm" value={d.hostname} onChange={(e) => setEditField(s.id, 'hostname', e.target.value)} aria-label="hostname" />
                          </div>
                        ) : (
                          <>
                            <div className="cell-title">{s.name}</div>
                            <div className="muted mono cell-sub">{s.hostname}</div>
                          </>
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <Input className="input-sm" value={d.ipAddress} onChange={(e) => setEditField(s.id, 'ipAddress', e.target.value)} aria-label="ip" />
                        ) : (
                          <span className="mono">{s.ipAddress ?? '—'}</span>
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <Input className="input-sm" type="number" min={1} max={65535} value={d.port} onChange={(e) => setEditField(s.id, 'port', e.target.value)} aria-label="port" />
                        ) : (
                          <span className="mono">{s.port ?? '—'}</span>
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <Input className="input-sm" value={d.provider} onChange={(e) => setEditField(s.id, 'provider', e.target.value)} aria-label="fournisseur" />
                        ) : (
                          s.provider ?? '—'
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <Input className="input-sm" value={d.region} onChange={(e) => setEditField(s.id, 'region', e.target.value)} aria-label="région" />
                        ) : (
                          s.region ?? '—'
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <Input className="input-sm" type="number" min={0} value={d.quotaMaxAccounts} onChange={(e) => setEditField(s.id, 'quotaMaxAccounts', e.target.value)} aria-label="quota" />
                        ) : (
                          s.quotaMaxAccounts != null ? `${s.quotaMaxAccounts}` : '—'
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <label className="check-row">
                            <input type="checkbox" checked={d.strictTls} onChange={(e) => setEditField(s.id, 'strictTls', e.target.checked)} />
                            Strict
                          </label>
                        ) : (
                          <Badge tone={s.strictTls ? 'ok' : 'warn'}>{s.strictTls ? 'Strict' : 'Off'}</Badge>
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <Select
                            className="select-sm"
                            value={d.panelProvider}
                            onChange={(e) => setEditField(s.id, 'panelProvider', e.target.value)}
                            aria-label="panneau"
                          >
                            {PANEL_PROVIDERS.map((p) => (
                              <option key={p.value} value={p.value}>{p.label}</option>
                            ))}
                          </Select>
                        ) : (
                          <Badge tone={panelTone(s.panelProvider ?? 'NONE')}>{panelLabel(s.panelProvider ?? 'NONE')}</Badge>
                        )}
                      </td>
                      <td>
                        {isEditing ? (
                          <Select
                            className="select-sm"
                            value={d.status}
                            onChange={(e) => setEditField(s.id, 'status', e.target.value)}
                            aria-label="statut"
                          >
                            {SERVER_STATUSES.map((st) => (
                              <option key={st} value={st}>{st}</option>
                            ))}
                          </Select>
                        ) : (
                          <Badge tone={statusTone(s.status)}>{s.status}</Badge>
                        )}
                      </td>
                      <td>
                        <div className="row ta-right">
                          {isEditing ? (
                            <>
                              <Button size="sm" disabled={busy === s.id} onClick={() => saveEdit(s.id, d)} title="Enregistrer">
                                <IconCheck size={14} />
                              </Button>
                              <Button size="sm" variant="secondary" onClick={() => setEditingId(null)} title="Annuler">
                                <IconX size={14} />
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button size="sm" variant="secondary" onClick={() => startEdit(s)} title="Modifier le serveur">
                                Modifier
                              </Button>
                              <Button size="sm" variant="danger" disabled={busy === s.id} onClick={() => handleDelete(s)} title="Supprimer le serveur">
                                <IconX size={14} />
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}
