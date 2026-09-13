'use client';

import { useEffect, useState } from 'react';
import {
  apiError,
  listLimitsIssues,
  listProjectsConsumption,
  LimitsIssue,
  ProjectConsumption,
  reapplyDeploymentLimits,
} from '@/lib/api';
import { useAdminSession } from '@/lib/session';
import { useToast } from '@/components/toast';
import { AppShell } from '@/components/app-shell';
import { ADMIN_NAV } from '@/config/nav';
import { Badge, Button, Denied, EmptyState, PageIntro, PageLoading } from '@/components/ui';

const LIMITS_STATUS_LABEL: Record<string, string> = {
  FAILED: 'Limites NON appliquées',
  PENDING_RETRY: 'En attente de ré-application',
};

type ModuleKind = 'SHARED_PROJECT' | 'PER_CLIENT_PROJECT' | null;

const MODULE_BADGE: Record<Exclude<ModuleKind, null>, { label: string; tone: 'violet' | 'ok' | 'info' | 'warn' | 'neutral' }> = {
  SHARED_PROJECT: { label: 'Module A — Partagé', tone: 'violet' },
  PER_CLIENT_PROJECT: { label: 'Module B — Client', tone: 'ok' },
};

function getModuleBadge(kind: ModuleKind) {
  if (!kind) return { label: '—', tone: 'neutral' as const };
  return MODULE_BADGE[kind];
}

function bar(used: number, limit: number | null, label: string) {
  if (!limit || limit <= 0) {
    return (
      <div className="bar-wrap" title="Pas de limite configurée">
        <div className="bar-label">{label}</div>
        <div className="bar-track">
          <div className="bar-fill neutral" style={{ width: '100%' }} />
        </div>
        <div className="bar-meta muted text-xs">Illimité</div>
      </div>
    );
  }
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const over = used > limit;
  return (
    <div className="bar-wrap" title={`${used} / ${limit} ${label}`}>
      <div className="bar-label">{label}</div>
      <div className="bar-track">
        <div
          className={`bar-fill ${over ? 'danger' : 'ok'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="bar-meta muted text-xs">
        {used} / {limit} {label} {over && <Badge tone="danger">DÉPASSÉ</Badge>}
      </div>
    </div>
  );
}

export default function ManagerMonitoringPage() {
  const { phase, me, token } = useAdminSession();
  const toast = useToast();
  const [rows, setRows] = useState<ProjectConsumption[]>([]);
  const [issues, setIssues] = useState<LimitsIssue[]>([]);
  const [reapplyId, setReapplyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (phase === 'ready' && token) void load(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, token]);

  async function load(t: string) {
    setLoading(true);
    const [r, i] = await Promise.all([listProjectsConsumption(t), listLimitsIssues(t)]);
    setLoading(false);
    if (!r.ok) return toast.error(apiError(r, 'Impossible de charger le monitoring.'));
    setRows((r.data as ProjectConsumption[]) ?? []);
    if (i.ok) setIssues((i.data as LimitsIssue[]) ?? []);
  }

  async function refresh() {
    if (!token) return;
    await load(token);
    toast.ok('Actualisé.');
  }

  async function reapply(id: string, clientEmail: string, appName: string | null) {
    if (!token) return;
    setReapplyId(id);
    const r = await reapplyDeploymentLimits(token, id);
    setReapplyId(null);
    if (!r.ok) {
      return toast.error(apiError(r, `Échec de la ré-application (${clientEmail} / ${appName ?? id}).`));
    }
    toast.ok((r.data as { message?: string }).message ?? 'Limites ré-appliquées.');
    await load(token);
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
      <div className="wrap-lg">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <PageIntro
            eyebrow="Monitoring"
            title="Projets Coolify — Consommation"
            sub="Agrégation offline des ressources (RAM/CPU/Disque) par projet Coolify. Trié par consommation totale décroissante. Badges d'alerte si les limites du pack sont dépassées."
          />
          <Button onClick={refresh} disabled={loading}>
            {loading ? 'Chargement…' : 'Actualiser'}
          </Button>
        </div>

        {issues.length > 0 && (
          <div className="alert error" style={{ marginBottom: '1.5rem' }}>
            <strong>
              {issues.length} app{issues.length > 1 ? 's' : ''} avec des limites non appliquées
            </strong>
            <div className="muted text-sm" style={{ marginTop: '0.25rem' }}>
              L'app fonctionne, mais sa limite RAM/CPU n'est pas posée sur le conteneur. Cliquez
              « Réappliquer » pour re-poser les limites sans redéploiement ni interruption du service client.
              Retry non automatique (anti-spam API Coolify) ; la ré-application pose un cooldown de 60 s.
            </div>
            <div className="table-wrap" style={{ marginTop: '0.75rem' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>App</th>
                    <th>Limites visées</th>
                    <th>Statut</th>
                    <th>Erreur</th>
                    <th>Retries</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {issues.map((q) => (
                    <tr key={q.id}>
                      <td>
                        <div className="cell-title">{q.clientEmail}</div>
                        <div className="muted cell-sub">{q.clientName ?? '—'}</div>
                      </td>
                      <td>
                        <div className="cell-title">{q.appName ?? '—'}</div>
                        {q.fqdn && <div className="muted cell-sub font-mono">{q.fqdn}</div>}
                      </td>
                      <td>
                        {q.limitsRamMb != null ? `${q.limitsRamMb} Mo RAM` : '—'}
                        {q.limitsCpu != null ? ` / ${q.limitsCpu} CPU` : ''}
                      </td>
                      <td>
                        <Badge tone={q.limitsStatus === 'FAILED' ? 'danger' : 'warn'}>
                          {LIMITS_STATUS_LABEL[q.limitsStatus] ?? q.limitsStatus}
                        </Badge>
                      </td>
                      <td>
                        <div className="muted cell-sub">{q.limitsLastError ?? '—'}</div>
                      </td>
                      <td>{q.limitsRetryCount}</td>
                      <td>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => reapply(q.id, q.clientEmail, q.appName)}
                          disabled={reapplyId === q.id}
                        >
                          {reapplyId === q.id ? '…' : 'Réappliquer'}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {rows.length === 0 ? (
          <EmptyState>Aucun projet avec déploiements actifs.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Projet / Pack</th>
                  <th>Module</th>
                  <th>Apps</th>
                  <th>RAM</th>
                  <th>CPU</th>
                  <th>Disque</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const mod = getModuleBadge(r.moduleKind);
                  return (
                    <tr key={r.id}>
                      <td>
                        <div className="cell-title">{r.clientEmail}</div>
                        <div className="muted cell-sub">{r.clientName ?? '—'}</div>
                      </td>
                      <td>
                        <div className="font-mono text-sm">{r.projectUuid}</div>
                        {r.packName && <div className="muted cell-sub">Pack : {r.packName}</div>}
                      </td>
                      <td>
                        <Badge tone={mod.tone}>{mod.label}</Badge>
                      </td>
                      <td>
                        <Badge tone={r.overRam || r.overCpu || r.overDisk ? 'danger' : 'ok'}>
                          {r.appsCount}
                        </Badge>
                      </td>
                      <td>{bar(r.totalRamMb, r.budgetRamMb, 'Mo')}</td>
                      <td>{bar(r.totalCpuCores, r.budgetCpuCores, 'cœurs')}</td>
                      <td>{bar(r.totalStorageGb ?? 0, r.budgetStorageGb, 'Go')}</td>
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