'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiError } from '@/lib/api';
import {
  checkSubdomainAvailability,
  createCloudflareRecord,
  deleteCloudflareDomain,
  deleteCloudflareRecord,
  getCloudflareSettings,
  listCloudflareDomains,
  listCloudflareRecords,
  registerCloudflareDomain,
  setCloudflareRoot,
  updateCloudflareDomain,
  updateCloudflareSettings,
  verifyCloudflare,
  type CloudflareDomain,
  type CloudflareSettings,
  type CloudflareZone,
  type DnsRecord,
  type DnsRecordType,
} from '@/lib/api';
import { useAdminSession } from '@/lib/session';
import { useToast } from '@/components/toast';
import { AppShell } from '@/components/app-shell';
import { ADMIN_NAV } from '@/config/nav';
import {
  Alert,
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
import { IconCheck, IconGlobe, IconPlus, IconRefresh, IconTrash } from '@/components/icons';

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'NS', 'CAA'] as const;

type FirstDnsRecordType = (typeof RECORD_TYPES)[number];

interface RecordForm {
  type: DnsRecordType;
  name: string;
  content: string;
  proxied: boolean;
  ttl: string;
}

const EMPTY_RECORD: RecordForm = { type: 'A' as DnsRecordType, name: '', content: '', proxied: true, ttl: '1' };

export default function ManagerDnsPage() {
  const { phase, me, token } = useAdminSession();
  const toast = useToast();

  const [settings, setSettings] = useState<CloudflareSettings | null>(null);
  const [domains, setDomains] = useState<CloudflareDomain[]>([]);
  const [zones, setZones] = useState<CloudflareZone[]>([]);
  const [showSetup, setShowSetup] = useState(false);
  const [apiToken, setApiToken] = useState('');
  const [accountEmail, setAccountEmail] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [verifyRes, setVerifyRes] = useState<{ ok: boolean; detail: string } | null>(null);
  // Édition locale de la cible CNAME par domaine.
  const [cnameDraft, setCnameDraft] = useState<Record<string, string>>({});

  // Records (live) du domaine sélectionné.
  const [selectedDomainId, setSelectedDomainId] = useState('');
  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [recordsBusy, setRecordsBusy] = useState(false);
  const [showRecordForm, setShowRecordForm] = useState(false);
  const [rf, setRf] = useState<RecordForm>({ ...EMPTY_RECORD });

  const loadSettings = useCallback(async () => {
    if (!token) return;
    const res = await getCloudflareSettings(token);
    if (!res.ok) {
      toast.error(apiError(res, 'Configuration Cloudflare illisible.'));
      return;
    }
    const s = res.data as CloudflareSettings;
    setSettings(s);
    setShowSetup(!s.hasApiToken);
    if (s.accountEmail) setAccountEmail(s.accountEmail);
  }, [token, toast]);

  const loadDomains = useCallback(async () => {
    if (!token) return;
    const res = await listCloudflareDomains(token);
    if (res.ok) {
      const list = (res.data as CloudflareDomain[]) ?? [];
      setDomains(list);
      setCnameDraft((cur) => {
        const next = { ...cur };
        for (const d of list) if (next[d.id] === undefined) next[d.id] = d.cnameTarget ?? '';
        return next;
      });
      // Garde le domaine sélectionné si présent, sinon la racine / le premier.
      setSelectedDomainId((cur) =>
        list.some((d) => d.id === cur) ? cur : (list.find((d) => d.isRoot)?.id ?? list[0]?.id ?? ''),
      );
    } else {
      toast.error(apiError(res, 'Liste des domaines illisible.'));
    }
  }, [token, toast]);

  const loadRecords = useCallback(
    async (domainId: string) => {
      if (!token || !domainId) return;
      setRecordsBusy(true);
      const res = await listCloudflareRecords(token, domainId);
      setRecordsBusy(false);
      if (res.ok) setRecords((res.data as DnsRecord[]) ?? []);
      else toast.error(apiError(res, 'Enregistrements DNS illisibles.'));
    },
    [token, toast],
  );

  useEffect(() => {
    if (phase === 'ready' && token) void loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, token]);

  useEffect(() => {
    if (phase === 'ready' && token && settings?.hasApiToken) void loadDomains();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, token, settings?.hasApiToken]);

  useEffect(() => {
    if (settings?.hasApiToken) void loadRecords(selectedDomainId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDomainId, settings?.hasApiToken]);

  const selectedDomain = useMemo(
    () => domains.find((d) => d.id === selectedDomainId) ?? null,
    [domains, selectedDomainId],
  );

  async function handleSaveToken() {
    if (!token) return;
    setBusy('save-token');
    const dto: Record<string, string> = {};
    if (apiToken.trim()) dto.apiToken = apiToken.trim();
    if (accountEmail.trim()) dto.accountEmail = accountEmail.trim();
    const res = await updateCloudflareSettings(token, dto);
    setBusy(null);
    if (!res.ok) return toast.error(apiError(res, 'Sauvegarde impossible.'));
    toast.ok('Configuration enregistrée.');
    await loadSettings();
  }

  async function handleVerify() {
    if (!token || !settings?.hasApiToken) return;
    setBusy('verify');
    const res = await verifyCloudflare(token);
    setBusy(null);
    const out = res.ok
      ? (res.data as { ok: boolean; zones: CloudflareZone[]; detail: string })
      : { ok: false, zones: [], detail: apiError(res, 'Vérification impossible.') };
    setVerifyRes({ ok: out.ok, detail: out.detail });
    setZones(out.zones ?? []);
    if (out.ok) toast.ok('Jeton Cloudflare valide.');
    else toast.error(out.detail);
  }

  async function handleImportZone(zone: CloudflareZone) {
    if (!token) return;
    setBusy(`import-${zone.id}`);
    const res = await registerCloudflareDomain(token, { zoneId: zone.id, name: zone.name });
    setBusy(null);
    if (!res.ok) return toast.error(apiError(res, 'Import impossible.'));
    toast.ok(`« ${zone.name} » importé.`);
    await loadDomains();
  }

  async function handleRemoveDomain(d: CloudflareDomain) {
    if (!token) return;
    if (!window.confirm(`Retirer « ${d.name} » ? (les allocations client existantes sont conservées)`)) return;
    setBusy(`rm-${d.id}`);
    const res = await deleteCloudflareDomain(token, d.id);
    setBusy(null);
    if (!res.ok) return toast.error(apiError(res, 'Suppression impossible.'));
    toast.ok('Domaine retiré.');
    await loadDomains();
  }

  async function handleSetRoot(d: CloudflareDomain, makeRoot: boolean) {
    if (!token) return;
    setBusy(`root-${d.id}`);
    const res = await setCloudflareRoot(token, makeRoot ? d.id : null);
    setBusy(null);
    if (!res.ok) return toast.error(apiError(res, 'Sélection impossible.'));
    toast.ok(makeRoot ? `« ${d.name} » est le domaine racine.` : 'Racine désélectionnée.');
    await loadSettings();
    await loadDomains();
  }

  async function handleSaveCnameTarget(d: CloudflareDomain) {
    if (!token) return;
    setBusy(`cname-${d.id}`);
    const res = await updateCloudflareDomain(token, d.id, { cnameTarget: cnameDraft[d.id] ?? '' });
    setBusy(null);
    if (!res.ok) return toast.error(apiError(res, 'Cible impossible à enregistrer.'));
    toast.ok('Cible CNAME enregistrée.');
    await loadDomains();
  }

  async function handleCheck() {
    if (!token || !settings?.rootDomainId) {
      toast.info('Aucun domaine racine sélectionné.');
      return;
    }
    if (!rf.name.trim()) {
      toast.info('Entrez un sous-domaine pour vérifier sa disponibilité.');
      return;
    }
    setBusy('check');
    const label = rf.name.trim().split('.')[0];
    const res = await checkSubdomainAvailability(token, label, settings.rootDomainId);
    setBusy(null);
    if (!res.ok) return toast.error(apiError(res, 'Vérification impossible.'));
    const out = res.data as { available: boolean; fqdn: string };
    if (out.available) toast.ok(`« ${out.fqdn} » est disponible.`);
    else toast.error(`« ${out.fqdn} » est déjà pris.`);
  }

  async function handleCreateRecord() {
    if (!token || !selectedDomain) return;
    if (!rf.name.trim() || !rf.content.trim()) return toast.error('Nom et contenu requis.');
    setBusy('record');
    const dto = {
      type: rf.type,
      name: rf.name.trim(),
      content: rf.content.trim(),
      proxied: rf.proxied,
      ttl: rf.ttl === '' || rf.ttl === '1' ? undefined : Number(rf.ttl),
    };
    const res = await createCloudflareRecord(token, selectedDomain.id, dto);
    setBusy(null);
    if (!res.ok) return toast.error(apiError(res, 'Création de l’enregistrement impossible.'));
    toast.ok('Enregistrement créé sur Cloudflare.');
    setRf({ ...EMPTY_RECORD });
    setShowRecordForm(false);
    await loadRecords(selectedDomain.id);
  }

  async function handleDeleteRecord(rec: DnsRecord) {
    if (!token || !selectedDomain) return;
    if (!window.confirm(`Supprimer l’enregistrement ${rec.type} ${rec.name} ?`)) return;
    setBusy(`rec-${rec.id}`);
    const res = await deleteCloudflareRecord(token, selectedDomain.id, rec.id);
    setBusy(null);
    if (!res.ok) return toast.error(apiError(res, 'Suppression impossible.'));
    toast.ok('Enregistrement supprimé.');
    await loadRecords(selectedDomain.id);
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

  const importableZones = zones.filter((z) => !domains.some((d) => d.zoneId === z.id));

  return (
    <AppShell me={me} nav={ADMIN_NAV} tenant={{ label: 'Administration' }}>
      <div className="wrap-md">
        <PageIntro
          eyebrow="Administration"
          title="DNS & Cloudflare"
          sub="Contrôle DNS complet via l’API Cloudflare. Sélectionnez un domaine racine : il servira à créer gratuitement les sous-domaines des apps client."
        />

        {/* ── Compte Cloudflare ── */}
        <Panel
          title="Compte Cloudflare"
          sub="Le jeton API est chiffré au repos et jamais renvoyé : seul son état (présent ou non) est exposé."
          className="mb"
        >
          <div className="row between wrap" style={{ gap: 14, marginBottom: 14 }}>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <Badge tone={settings?.hasApiToken ? 'ok' : 'warn'}>
                {settings?.hasApiToken ? 'Connecté' : 'Non configuré'}
              </Badge>
              {settings?.accountEmail && (
                <span className="muted" style={{ fontSize: 13.5 }}>
                  {settings.accountEmail}
                </span>
              )}
              {settings?.rootDomain && <Badge tone="violet">Racine : {settings.rootDomain.name}</Badge>}
            </div>
            <Button size="sm" variant="secondary" onClick={() => setShowSetup((v) => !v)}>
              <IconRefresh size={14} /> {showSetup ? 'Fermer' : 'Configurer / vérifier'}
            </Button>
          </div>

          {showSetup && (
            <div className="stack">
              <div className="grid-form">
                <Field label="Jeton d’API Cloudflare (Zone/DNS edit)" hint="Write-only : jamais affiché ni renvoyé, chiffré AES-256-GCM au repos. Vide = ne rien changer.">
                  <Input
                    type="password"
                    value={apiToken}
                    onChange={(e) => setApiToken(e.target.value)}
                    placeholder="cfut_… (laisser vide = inchangé)"
                    autoComplete="off"
                  />
                </Field>
                <Field label="Email du compte (facultatif)">
                  <Input value={accountEmail} onChange={(e) => setAccountEmail(e.target.value)} placeholder="admin@exemple.com" />
                </Field>
              </div>
              <div className="grid-form-actions">
                <Button disabled={busy === 'save-token'} onClick={handleSaveToken}>
                  {busy === 'save-token' ? 'Enregistrement…' : 'Enregistrer la configuration'}
                </Button>
                {settings?.hasApiToken && (
                  <Button variant="secondary" disabled={busy === 'verify'} onClick={handleVerify}>
                    <IconRefresh size={14} /> Vérifier & lister les zones
                  </Button>
                )}
              </div>
              {verifyRes && <Alert tone={verifyRes.ok ? 'ok' : 'warn'}>{verifyRes.detail}</Alert>}

              {importableZones.length > 0 && (
                <div className="stack">
                  <div className="muted" style={{ fontSize: 13.5, marginBottom: 6 }}>
                    Zones du compte pas encore importées :
                  </div>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    {importableZones.map((z) => (
                      <Badge key={z.id} tone="info">
                        <span className="row" style={{ gap: 8 }}>
                          {z.name}
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy === `import-${z.id}`}
                            onClick={() => void handleImportZone(z)}
                          >
                            <IconPlus size={12} /> Importer
                          </Button>
                        </span>
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </Panel>

        {/* ── Domaines racines ── */}
        <Panel
          title="Domaines racines"
          sub="Chaque domaine importé peut devenir la racine où sont créés les sous-domaines des apps client (≤ 1 racine)."
          className="mb"
        >
          {domains.length === 0 ? (
            <EmptyState>
              <IconGlobe />
              <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Aucun domaine importé</div>
              <div className="muted" style={{ fontSize: 13.5 }}>
                Connectez et vérifiez le compte ci-dessus, puis importez une zone.
              </div>
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table table-wide">
                <thead>
                  <tr>
                    <th>Domaine</th>
                    <th>Cible des CNAME client</th>
                    <th>Racine</th>
                    <th>Allocations</th>
                    <th className="ta-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {domains.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <div className="cell-title">{d.name}</div>
                        <div className="muted cell-sub">zone {d.zoneId.slice(0, 6)}…</div>
                      </td>
                      <td>
                        <div className="row" style={{ gap: 8 }}>
                          <Input
                            style={{ minWidth: 200 }}
                            value={cnameDraft[d.id] ?? ''}
                            placeholder="panel.arumdigital.com"
                            onChange={(e) => setCnameDraft((cur) => ({ ...cur, [d.id]: e.target.value }))}
                          />
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy === `cname-${d.id}`}
                            onClick={() => void handleSaveCnameTarget(d)}
                            title="Enregistrer la cible"
                          >
                            <IconCheck size={14} />
                          </Button>
                        </div>
                      </td>
                      <td>
                        {d.isRoot ? (
                          <Badge tone="violet">Racine</Badge>
                        ) : (
                          <Button size="sm" variant="secondary" disabled={busy === `root-${d.id}`} onClick={() => void handleSetRoot(d, true)}>
                            Définir racine
                          </Button>
                        )}
                      </td>
                      <td>{d.clientSubdomainCount}</td>
                      <td>
                        <div className="row ta-right">
                          {d.isRoot && (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busy === `root-${d.id}`}
                              onClick={() => void handleSetRoot(d, false)}
                              title="Désélectionner la racine"
                            >
                              <IconRefresh size={13} />
                            </Button>
                          )}
                          <Button size="sm" variant="danger" disabled={busy === `rm-${d.id}`} onClick={() => void handleRemoveDomain(d)} title="Retirer">
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
          {settings?.rootDomain && (
            <div className="muted" style={{ fontSize: 13.5, marginTop: 10 }}>
              Les clients choisissent librement un sous-domaine sous{' '}
              <strong style={{ color: 'var(--text-primary)' }}>{settings.rootDomain.name}</strong> (CNAME →{' '}
              {settings.rootDomain.cnameTarget ?? 'hostname Coolify'}, proxy Cloudflare actif).
            </div>
          )}
        </Panel>

        {/* ── Enregistrements DNS (live) ── */}
        {settings?.hasApiToken && domains.length > 0 && selectedDomain && (
          <Panel
            title="Enregistrements DNS"
            sub={`Table en lecture/écriture directe de l’API Cloudflare (proxy live) — ${selectedDomain.name}.`}
            className="mb"
          >
            <div className="row between wrap" style={{ gap: 10, marginBottom: 14 }}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <Select value={selectedDomainId} onChange={(e) => setSelectedDomainId(e.target.value)} style={{ minWidth: 220 }}>
                  {domains.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                      {d.isRoot ? ' (racine)' : ''}
                    </option>
                  ))}
                </Select>
                <Button size="sm" variant="secondary" disabled={recordsBusy} onClick={() => void loadRecords(selectedDomain.id)} title="Rafraîchir">
                  <IconRefresh size={14} />
                </Button>
              </div>
              <Button size="sm" onClick={() => setShowRecordForm((v) => !v)}>
                {showRecordForm ? 'Fermer le formulaire' : 'Ajouter un enregistrement'}
              </Button>
            </div>

            {showRecordForm && (
              <div className="grid-form mb">
                <Field label="Type">
                  <Select value={rf.type} onChange={(e) => setRf({ ...rf, type: e.target.value as DnsRecordType })}>
                    {RECORD_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Nom">
                  <Input value={rf.name} onChange={(e) => setRf({ ...rf, name: e.target.value })} placeholder={`mon-sous-domaine.${selectedDomain.name}`} />
                </Field>
                <Field label="Contenu / cible">
                  <Input value={rf.content} onChange={(e) => setRf({ ...rf, content: e.target.value })} placeholder={rf.type === 'CNAME' ? 'panel.arumdigital.com' : '192.0.2.1'} />
                </Field>
                <Field label="TTL">
                  <Input value={rf.ttl} onChange={(e) => setRf({ ...rf, ttl: e.target.value })} placeholder="1 = Auto" />
                </Field>
                <div className="grid-form-actions" style={{ gridColumn: '1 / -1' }}>
                  <Button disabled={busy === 'record'} onClick={() => void handleCreateRecord()}>
                    <IconPlus size={14} /> Créer sur Cloudflare
                  </Button>
                  <Button variant="secondary" disabled={busy === 'check'} onClick={() => void handleCheck()}>
                    Vérifier la dispo sous {settings.rootDomain?.name ?? 'la racine'}
                  </Button>
                </div>
              </div>
            )}

            {recordsBusy ? (
              <PageLoading label="Chargement des enregistrements…" />
            ) : records.length === 0 ? (
              <EmptyState>
                <IconGlobe />
                <div className="muted">Aucun enregistrement sur {selectedDomain.name}.</div>
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table table-wide">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Nom</th>
                      <th>Contenu</th>
                      <th>Proxy</th>
                      <th className="ta-right">TTL</th>
                      <th className="ta-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <Badge tone={r.type === 'CNAME' ? 'violet' : 'info'}>{r.type}</Badge>
                        </td>
                        <td>
                          <div className="cell-title" style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 13 }}>
                            {r.name}
                          </div>
                        </td>
                        <td>
                          <div className="muted" style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12.5 }}>
                            {r.content}
                          </div>
                        </td>
                        <td>
                          <Badge tone={r.proxied ? 'amber' : 'neutral'}>{r.proxied ? 'Proxied' : 'DNS only'}</Badge>
                        </td>
                        <td className="ta-right">{r.ttl === 1 ? 'Auto' : r.ttl}</td>
                        <td>
                          <div className="row ta-right">
                            <Button size="sm" variant="danger" disabled={busy === `rec-${r.id}`} onClick={() => void handleDeleteRecord(r)} title="Supprimer">
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
          </Panel>
        )}

        {!settings?.hasApiToken && (
          <Alert tone="info">
            Configurez un jeton Cloudflare (ci-dessus) pour importer des domaines, sélectionner la racine et piloter les
            enregistrements DNS.
          </Alert>
        )}
      </div>
    </AppShell>
  );
}