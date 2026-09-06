'use client';

import { useEffect, useState } from 'react';
import {
  apiError,
  createDeploymentModule,
  createPack,
  deleteDeploymentModule,
  deletePack,
  DeploymentModule,
  DeploymentModuleKind,
  listDeploymentModuleProjects,
  listDeploymentModules,
  listPacks,
  listServers,
  PackAdmin,
  ServerAdmin,
  updateDeploymentModule,
  updatePack,
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
import {
  IconLayers,
  IconPencil,
  IconPlus,
  IconServer,
  IconTrash,
  IconX,
} from '@/components/icons';

const PACK_STATUSES = ['DRAFT', 'ACTIVE', 'SUSPENDED', 'DISABLED'];
// Quotas d'apps proposés (null = illimité).
const MAX_APPS_CHOICES: { label: string; value: string }[] = [
  { label: '1 app', value: '1' },
  { label: '5 apps', value: '5' },
  { label: '10 apps', value: '10' },
  { label: 'Illimité', value: '' },
];
const EMPTY = { name: '', description: '', ramMb: '', cpuCores: '1', storageLimit: '', bandwidth: '', maxApps: '' };
const EMPTY_MODULE = {
  name: '',
  code: '',
  kind: 'SHARED_PROJECT' as DeploymentModuleKind,
  description: '',
  isActive: true,
  serverId: '',
  sharedProjectUuid: '',
  sharedProjectName: '',
  perClientPrefix: 'client',
  overrideRamMb: '',
  overrideCpuCores: '',
  overrideStorageLimit: '',
};

export default function ManagerPacksPage() {
  const { phase, me, token } = useAdminSession();
  const toast = useToast();
  const [packs, setPacks] = useState<PackAdmin[]>([]);
  const [modules, setModules] = useState<DeploymentModule[]>([]);
  const [servers, setServers] = useState<ServerAdmin[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [f, setF] = useState({ ...EMPTY });

  // État du module (fonction `f` déjà prise → m pour module).
  const [showModuleForm, setShowModuleForm] = useState(false);
  const [editModuleId, setEditModuleId] = useState<string | null>(null);
  const [m, setM] = useState({ ...EMPTY_MODULE });
  // Projets Coolify live du module (choix du projet partagé A).
  const [projects, setProjects] = useState<{ uuid: string; name: string }[]>([]);
  const [projectsBusy, setProjectsBusy] = useState(false);

  useEffect(() => {
    if (phase === 'ready' && token) void loadAll(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, token]);

  async function loadAll(t: string) {
    await Promise.all([loadPacks(t), loadModules(t), loadServers(t)]);
  }

  async function loadPacks(t: string) {
    const r = await listPacks(t);
    if (r.ok) setPacks((r.data as PackAdmin[]) ?? []);
  }

  async function loadModules(t: string) {
    const r = await listDeploymentModules(t);
    if (r.ok) setModules((r.data as DeploymentModule[]) ?? []);
  }

  async function loadServers(t: string) {
    const r = await listServers(t);
    if (r.ok) setServers((r.data as ServerAdmin[]) ?? []);
  }

  function resetForm() {
    setF({ ...EMPTY });
    setEditId(null);
    setShowForm(false);
  }

  function startEdit(p: PackAdmin) {
    setEditId(p.id);
    setF({
      name: p.name,
      description: p.description ?? '',
      ramMb: String(p.ramMb),
      cpuCores: String(p.cpuCores),
      storageLimit: p.storageLimit != null ? String(p.storageLimit) : '',
      bandwidth: p.bandwidth ?? '',
      maxApps: p.maxApps != null ? String(p.maxApps) : '',
    });
    setShowForm(true);
  }

  function field(name: keyof typeof EMPTY, v: string) {
    setF((prev) => ({ ...prev, [name]: v }));
  }

  async function handleSave() {
    if (!f.name.trim()) return toast.error('Le nom du pack est obligatoire.');
    const ramMb = Number(f.ramMb);
    if (!Number.isInteger(ramMb) || ramMb < 1)
      return toast.error('RAM (Mo) : entier positif requis.');
    const cpuCores = f.cpuCores.trim() === '' ? 1 : Number(f.cpuCores);
    if (!Number.isFinite(cpuCores) || cpuCores <= 0)
      return toast.error('CPU (cœurs) : nombre strictement positif requis.');
    const storageLimit = f.storageLimit.trim() === '' ? null : Number(f.storageLimit);
    if (storageLimit != null && (!Number.isInteger(storageLimit) || storageLimit < 1))
      return toast.error('Disque (Go) : entier >= 1 requis (quota enregistré, non actif).');
    const maxApps = f.maxApps.trim() === '' ? null : Number(f.maxApps);
    if (maxApps != null && (!Number.isInteger(maxApps) || maxApps < 1))
      return toast.error('Apps max : entier >= 1 requis (vide = illimité).');
    const payload = {
      name: f.name.trim(),
      description: f.description.trim() || undefined,
      ramMb,
      cpuCores,
      storageLimit,
      bandwidth: f.bandwidth.trim() || undefined,
      maxApps,
    };
    setBusy('save');
    const r = editId
      ? await updatePack(token, editId, payload)
      : await createPack(token, payload);
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de l’enregistrement du pack.'));
    toast.ok(editId ? 'Pack mis à jour.' : 'Pack créé.');
    resetForm();
    void loadPacks(token);
  }

  async function changeStatus(p: PackAdmin, st: string) {
    setBusy(p.id);
    const r = await updatePack(token, p.id, { status: st });
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de la mise à jour.'));
    toast.ok('Statut du pack mis à jour.');
    void loadPacks(token);
  }

  async function handleDelete(p: PackAdmin) {
    if (!window.confirm(`Supprimer le pack « ${p.name} » ?`)) return;
    setBusy(p.id);
    const r = await deletePack(token, p.id);
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de la suppression.'));
    toast.ok('Pack supprimé.');
    void loadPacks(token);
  }

  // ── Modules (Configuration de déploiement) ──────────────────────────────────
  function coolifyServers(): ServerAdmin[] {
    return servers.filter((s) => s.panelProvider === 'COOLIFY');
  }

  function resetModuleForm() {
    setM({ ...EMPTY_MODULE });
    setEditModuleId(null);
    setProjects([]);
    setShowModuleForm(false);
  }

  function startModuleEdit(mod: DeploymentModule) {
    setEditModuleId(mod.id);
    setM({
      name: mod.name,
      code: mod.code,
      kind: mod.kind,
      description: mod.description ?? '',
      isActive: mod.isActive,
      serverId: mod.server?.id ?? '',
      sharedProjectUuid: mod.sharedProjectUuid ?? '',
      sharedProjectName: mod.sharedProjectName ?? '',
      perClientPrefix: mod.perClientPrefix,
      overrideRamMb: mod.overrideRamMb != null ? String(mod.overrideRamMb) : '',
      overrideCpuCores: mod.overrideCpuCores != null ? String(mod.overrideCpuCores) : '',
      overrideStorageLimit: mod.overrideStorageLimit != null ? String(mod.overrideStorageLimit) : '',
    });
    setProjects([]);
    setShowModuleForm(true);
  }

  function mfield(name: keyof typeof EMPTY_MODULE, v: string | boolean) {
    setM((prev) => ({ ...prev, [name]: v }));
  }

  /** Charge la liste LIVE des projets Coolify du serveur du module (Module A). */
  async function loadLiveProjects() {
    if (!editModuleId || !m.serverId) {
      return toast.error('Enregistrez d’abord le module avec un serveur Coolify.');
    }
    setProjectsBusy(true);
    const r = await listDeploymentModuleProjects(token, editModuleId);
    setProjectsBusy(false);
    if (!r.ok) return toast.error(apiError(r, 'Impossible de lister les projets Coolify.'));
    const res = r.data as { projects: { uuid: string; name: string }[]; selected: string | null };
    setProjects(res.projects ?? []);
    if (res.selected) {
      mfield('sharedProjectUuid', res.selected);
      const found = (res.projects ?? []).find((p) => p.uuid === res.selected);
      if (found) mfield('sharedProjectName', found.name);
    }
  }

  async function handleModuleSave() {
    if (!m.name.trim()) return toast.error('Le nom du module est obligatoire.');
    if (!m.code.trim()) return toast.error('Le code du module est obligatoire (ex : A, B, C…).');
    if (!m.serverId) return toast.error('Associez le module à un serveur Coolify connecté.');
    if (m.kind === 'SHARED_PROJECT' && !m.sharedProjectUuid) {
      return toast.error('Module A : choisissez le projet Coolify partagé depuis la liste live.');
    }
    const overrideRamMb = m.overrideRamMb.trim() === '' ? null : Number(m.overrideRamMb);
    if (overrideRamMb != null && (!Number.isInteger(overrideRamMb) || overrideRamMb < 1))
      return toast.error('Override RAM : entier >= 1 Mo requis.');
    const overrideCpuCores = m.overrideCpuCores.trim() === '' ? null : Number(m.overrideCpuCores);
    if (overrideCpuCores != null && (!Number.isFinite(overrideCpuCores) || overrideCpuCores <= 0))
      return toast.error('Override CPU : nombre strictement positif requis.');
    const overrideStorageLimit = m.overrideStorageLimit.trim() === '' ? null : Number(m.overrideStorageLimit);
    if (overrideStorageLimit != null && (!Number.isInteger(overrideStorageLimit) || overrideStorageLimit < 1))
      return toast.error('Override disque : entier >= 1 Go requis.');
    const payload = {
      name: m.name.trim(),
      code: m.code.trim(),
      kind: m.kind,
      description: m.description.trim() || undefined,
      isActive: m.isActive,
      serverId: m.serverId,
      sharedProjectUuid: m.sharedProjectUuid || null,
      sharedProjectName: m.sharedProjectName || null,
      perClientPrefix: m.perClientPrefix.trim() || 'client',
      overrideRamMb,
      overrideCpuCores,
      overrideStorageLimit,
    };
    setBusy('mod-save');
    const r = editModuleId
      ? await updateDeploymentModule(token, editModuleId, payload)
      : await createDeploymentModule(token, payload);
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de l’enregistrement du module.'));
    toast.ok(editModuleId ? 'Module mis à jour.' : 'Module créé.');
    resetModuleForm();
    void loadModules(token);
  }

  async function toggleModuleActive(mod: DeploymentModule) {
    setBusy(mod.id);
    const r = await updateDeploymentModule(token, mod.id, { isActive: !mod.isActive });
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de la mise à jour.'));
    toast.ok(mod.isActive ? 'Module désactivé.' : 'Module activé.');
    void loadModules(token);
  }

  async function handleModuleDelete(mod: DeploymentModule) {
    if (!window.confirm(`Supprimer le module « ${mod.name} » (${mod.code}) ?`)) return;
    setBusy(mod.id);
    const r = await deleteDeploymentModule(token, mod.id);
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de la suppression.'));
    toast.ok('Module supprimé.');
    void loadModules(token);
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

  return (
    <AppShell me={me} nav={ADMIN_NAV} tenant={{ label: 'Administration' }}>
      <div className="wrap-md">
        <PageIntro
          eyebrow="Administration"
          title="Packs (limites de ressources)"
          sub="Gabarits de ressources assignés aux produits. La RAM + CPU d'un pack ACTIVE sont appliquées à l'app de l'utilisateur lors d'un déploiement sur Coolify."
        >
          <Button onClick={() => setShowForm((v) => !v)}>
            {showForm ? <IconX size={14} /> : <IconPlus size={14} />}
            {showForm ? 'Fermer' : 'Nouveau pack'}
          </Button>
        </PageIntro>

        {showForm && (
          <Panel
            title={editId ? 'Modifier le pack' : 'Nouveau pack'}
            sub="RAM, CPU et nombre d'apps pilotent les limites ; disque et bande passante sont informatifs."
            className="mb"
          >
            <form
              className="grid-form"
              onSubmit={(e) => {
                e.preventDefault();
                void handleSave();
              }}
            >
              <Field label="Nom du pack" required>
                <Input value={f.name} onChange={(e) => field('name', e.target.value)} placeholder="Starter 1 Go" />
              </Field>
              <Field label="Description">
                <Input value={f.description} onChange={(e) => field('description', e.target.value)} placeholder="Petite app / site vitrine" />
              </Field>
              <Field label="RAM (Mo)" required>
                <Input type="number" min={1} step={256} value={f.ramMb} onChange={(e) => field('ramMb', e.target.value)} placeholder="1024" />
              </Field>
              <Field label="CPU (cœurs)">
                <Input type="number" min={0.25} step={0.25} value={f.cpuCores} onChange={(e) => field('cpuCores', e.target.value)} placeholder="1" />
              </Field>
              <Field label="Disque (Go)" hint="Quota enregistré — système de quota non actif encore">
                <Input type="number" min={1} step={1} value={f.storageLimit} onChange={(e) => field('storageLimit', e.target.value)} placeholder="20" />
              </Field>
              <Field label="Bande passante">
                <Input value={f.bandwidth} onChange={(e) => field('bandwidth', e.target.value)} placeholder="1 To / mois" />
              </Field>
              <Field label="Applications max" hint="Quota d'apps du plan (Phase 13). Vide = illimité.">
                <Select value={f.maxApps} onChange={(e) => field('maxApps', e.target.value)}>
                  {MAX_APPS_CHOICES.map((c) => (
                    <option key={c.value || 'unlim'} value={c.value}>{c.label}</option>
                  ))}
                </Select>
              </Field>
              <div className="grid-form-actions">
                <Button type="submit" disabled={busy === 'save'}>
                  {editId ? <IconPencil size={14} /> : <IconPlus size={14} />}
                  {busy === 'save' ? 'Enregistrement…' : editId ? 'Enregistrer' : 'Créer le pack'}
                </Button>
                {editId && (
                  <Button variant="secondary" onClick={resetForm}>
                    Annuler
                  </Button>
                )}
              </div>
            </form>
          </Panel>
        )}

        {packs.length === 0 ? (
          <div className="mb">
            <EmptyState>
              <IconLayers />
              <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Aucun pack</div>
              <div className="muted" style={{ fontSize: 13.5 }}>
                Créez votre premier gabarit de ressources via « Nouveau pack ».
              </div>
            </EmptyState>
          </div>
        ) : (
          <div className="table-wrap mb">
            <table className="table table-wide">
              <thead>
                <tr>
                  <th>Pack</th>
                  <th>RAM</th>
                  <th>CPU</th>
                  <th>Apps max</th>
                  <th>Disque</th>
                  <th>Bande passante</th>
                  <th>Produits</th>
                  <th>Statut</th>
                  <th className="ta-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {packs.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div className="cell-title">{p.name}</div>
                      {p.description && <div className="muted cell-sub">{p.description}</div>}
                      {p.deploymentModule && (
                        <div className="muted cell-sub">Module {p.deploymentModule.code}</div>
                      )}
                    </td>
                    <td><Badge tone="violet">{p.ramMb} Mo</Badge></td>
                    <td>{p.cpuCores} cœurs</td>
                    <td>{p.maxApps != null ? p.maxApps : '∞'}</td>
                    <td>{p.storageLimit != null ? `${p.storageLimit} Go` : '—'}</td>
                    <td>{p.bandwidth ?? '—'}</td>
                    <td>{p._count?.products ?? 0}</td>
                    <td>
                      <Select
                        className="select-sm"
                        value={p.status}
                        disabled={busy === p.id}
                        onChange={(e) => changeStatus(p, e.target.value)}
                        aria-label="statut"
                        style={{ minWidth: 130 }}
                      >
                        {PACK_STATUSES.map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </Select>
                    </td>
                    <td>
                      <div className="row ta-right">
                        <Button size="sm" variant="secondary" disabled={busy === p.id} onClick={() => startEdit(p)} title="Modifier">
                          <IconPencil size={14} />
                        </Button>
                        <Button size="sm" variant="danger" disabled={busy === p.id} onClick={() => handleDelete(p)} title="Supprimer">
                          <IconTrash size={14} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Configuration de déploiement (Phase 13) ──────────────────────── */}
        <div className="mb" />
        <PageIntro
          eyebrow="Configuration de déploiement"
          title="Méthodes / modules (A, B, C…)"
          sub="Comment les apps client sont regroupées sur Coolify : Module A = toutes les apps dans UN projet partagé (choisi ici) ; Module B = chaque client a SON projet dédié (nommé client-&lt;id&gt;). Les packs ci-dessus sont liés à un module."
        >
          <Button variant="secondary" onClick={() => { resetModuleForm(); setShowModuleForm((v) => !v); }}>
            {showModuleForm ? <IconX size={14} /> : <IconPlus size={14} />}
            {showModuleForm ? 'Fermer' : 'Nouveau module'}
          </Button>
        </PageIntro>

        {showModuleForm && (
          <Panel
            title={editModuleId ? `Modifier le module (${m.code})` : 'Nouveau module'}
            sub="Serveur = serveur Coolify connecté du module. Module A : choisissez le projet partagé depuis la liste live après enregistrement."
            className="mb"
          >
            <form
              className="grid-form"
              onSubmit={(e) => {
                e.preventDefault();
                void handleModuleSave();
              }}
            >
              <Field label="Nom" required>
                <Input value={m.name} onChange={(e) => mfield('name', e.target.value)} placeholder="Module A — projet partagé" />
              </Field>
              <Field label="Code" required hint="ex : A, B, C…">
                <Input value={m.code} onChange={(e) => mfield('code', e.target.value.toUpperCase())} placeholder="A" />
              </Field>
              <Field label="Type d'hébergement" required>
                <Select
                  value={m.kind}
                  onChange={(e) => mfield('kind', e.target.value as DeploymentModuleKind)}
                >
                  <option value="SHARED_PROJECT">A — projet partagé (plusieurs apps)</option>
                  <option value="PER_CLIENT_PROJECT">B — projet dédié par client</option>
                </Select>
              </Field>
              <Field label="Serveur Coolify" required>
                <Select value={m.serverId} onChange={(e) => mfield('serverId', e.target.value)}>
                  <option value="">— choisir —</option>
                  {coolifyServers().map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Description">
                <Input value={m.description} onChange={(e) => mfield('description', e.target.value)} placeholder="Usage / notes du module" />
              </Field>
              <Field label="Actif" hint="Un module désactivé refuse les nouveaux déploiements.">
                <label className="check">
                  <input type="checkbox" checked={m.isActive} onChange={(e) => mfield('isActive', e.target.checked)} />
                  <span>Module actif</span>
                </label>
              </Field>

              {m.kind === 'SHARED_PROJECT' ? (
                <>
                  <Field label="Projet Coolify partagé (Module A)" hint={editModuleId ? 'Chargez la liste live depuis le serveur du module.' : 'Enregistrez d’abord le module, puis modifiez-le pour choisir le projet.'}>
                    <div className="row" style={{ gap: 8 }}>
                      <Select
                        value={m.sharedProjectUuid}
                        onChange={(e) => {
                          mfield('sharedProjectUuid', e.target.value);
                          const found = projects.find((p) => p.uuid === e.target.value);
                          if (found) mfield('sharedProjectName', found.name);
                        }}
                        disabled={!editModuleId || projectsBusy}
                        className={!editModuleId ? 'is-muted' : ''}
                      >
                        <option value="">— projet —</option>
                        {projects.map((p) => (
                          <option key={p.uuid} value={p.uuid}>{p.name}</option>
                        ))}
                      </Select>
                      <Button
                        size="sm"
                        variant="secondary"
                        type="button"
                        disabled={!editModuleId || projectsBusy}
                        onClick={() => void loadLiveProjects()}
                        title="Charger la liste live des projets Coolify"
                      >
                        <IconServer size={14} />
                        {projectsBusy ? 'Chargement…' : 'Projets'}
                      </Button>
                    </div>
                  </Field>
                  {m.sharedProjectName && (
                    <div className="muted" style={{ fontSize: 13 }}>Projet sélectionné : {m.sharedProjectName}</div>
                  )}
                </>
              ) : (
                <Field label="Préfixe projet client (Module B)" hint="→ client-&lt;id&gt;. Retrouvable par le support.">
                  <Input value={m.perClientPrefix} onChange={(e) => mfield('perClientPrefix', e.target.value)} placeholder="client" />
                </Field>
              )}

              <Field label="Override RAM (Mo)" hint="Prioritaire sur le pack. Vide = défaut du pack.">
                <Input type="number" min={1} step={128} value={m.overrideRamMb} onChange={(e) => mfield('overrideRamMb', e.target.value)} placeholder="—" />
              </Field>
              <Field label="Override CPU (cœurs)" hint="Prioritaire sur le pack. Vide = défaut du pack.">
                <Input type="number" min={0.25} step={0.25} value={m.overrideCpuCores} onChange={(e) => mfield('overrideCpuCores', e.target.value)} placeholder="—" />
              </Field>
              <Field label="Override disque (Go)" hint="Enregistré — quota non actif encore.">
                <Input type="number" min={1} step={1} value={m.overrideStorageLimit} onChange={(e) => mfield('overrideStorageLimit', e.target.value)} placeholder="—" />
              </Field>

              <div className="grid-form-actions">
                <Button type="submit" disabled={busy === 'mod-save'}>
                  {editModuleId ? <IconPencil size={14} /> : <IconPlus size={14} />}
                  {busy === 'mod-save' ? 'Enregistrement…' : editModuleId ? 'Enregistrer' : 'Créer le module'}
                </Button>
                {editModuleId && (
                  <Button variant="secondary" onClick={resetModuleForm}>
                    Annuler
                  </Button>
                )}
              </div>
            </form>
          </Panel>
        )}

        {modules.length === 0 ? (
          <EmptyState>
            <IconServer />
            <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Aucun module de déploiement</div>
            <div className="muted" style={{ fontSize: 13.5 }}>
              Créez au moins un module (A / B) puis liez les packs.
            </div>
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table table-wide">
              <thead>
                <tr>
                  <th>Module</th>
                  <th>Type</th>
                  <th>Serveur</th>
                  <th>Cible</th>
                  <th>Apps</th>
                  <th>Limites</th>
                  <th>Actif</th>
                  <th className="ta-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {modules.map((mod) => (
                  <tr key={mod.id}>
                    <td>
                      <div className="cell-title">{mod.name}</div>
                      {mod.description && <div className="muted cell-sub">{mod.description}</div>}
                    </td>
                    <td>
                      <Badge tone={mod.kind === 'SHARED_PROJECT' ? 'violet' : 'blue'}>
                        {mod.code} · {mod.kind === 'SHARED_PROJECT' ? 'projet partagé' : 'projet client'}
                      </Badge>
                    </td>
                    <td>{mod.server?.name ?? '—'}</td>
                    <td>
                      {mod.kind === 'SHARED_PROJECT'
                        ? (mod.sharedProjectName ?? mod.sharedProjectUuid ?? '—')
                        : `client-<id> (${mod.perClientPrefix})`}
                    </td>
                    <td>{mod._count?.packs ?? 0}</td>
                    <td className="muted">
                      [RAM {mod.overrideRamMb != null ? `${mod.overrideRamMb} Mo` : 'pack'}] [CPU {mod.overrideCpuCores != null ? mod.overrideCpuCores : 'pack'}]
                    </td>
                    <td>
                      <Badge tone={mod.isActive ? 'green' : 'gray'}>{mod.isActive ? 'Actif' : 'Inactif'}</Badge>
                    </td>
                    <td>
                      <div className="row ta-right">
                        <Button size="sm" variant="secondary" disabled={busy === mod.id} onClick={() => startModuleEdit(mod)} title="Modifier">
                          <IconPencil size={14} />
                        </Button>
                        <Button size="sm" variant="secondary" disabled={busy === mod.id} onClick={() => toggleModuleActive(mod)} title={mod.isActive ? 'Désactiver' : 'Activer'}>
                          {mod.isActive ? 'Désactiver' : 'Activer'}
                        </Button>
                        <Button size="sm" variant="danger" disabled={busy === mod.id} onClick={() => handleModuleDelete(mod)} title="Supprimer">
                          <IconTrash size={14} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}