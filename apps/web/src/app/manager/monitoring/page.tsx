'use client';

import { useEffect, useState } from 'react';
import {
  apiError,
  listProjectsConsumption,
  ProjectConsumption,
} from '@/lib/api';
import { useAdminSession } from '@/lib/session';
import { useToast } from '@/components/toast';
import { AppShell } from '@/components/app-shell';
import { ADMIN_NAV } from '@/config/nav';
import { Badge, Button, Denied, EmptyState, PageIntro, PageLoading } from '@/components/ui';

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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (phase === 'ready' && token) void load(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, token]);

  async function load(t: string) {
    setLoading(true);
    const r = await listProjectsConsumption(t);
    setLoading(false);
    if (!r.ok) return toast.error(apiError(r, 'Impossible de charger le monitoring.'));
    setRows((r.data as ProjectConsumption[]) ?? []);
  }

  async function refresh() {
    if (!token) return;
    await load(token);
    toast.ok('Actualisé.');
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

        {rows.length === 0 ? (
          <EmptyState>Aucun projet avec déploiements actifs.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Projet Coolify</th>
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
                    <tr key={r.projectUuid}>
                      <td>
                        <div className="cell-title">{r.clientEmail}</div>
                        <div className="muted cell-sub">{r.clientName ?? '—'}</div>
                      </td>
                      <td>
                        <div className="font-mono text-sm">{r.projectUuid}</div>
                      </td>
                      <td>
                        <Badge tone={mod.tone}>{mod.label}</Badge>
                      </td>
                      <td>
                        <Badge tone={r.overRam || r.overCpu || r.overDisk ? 'danger' : 'ok'}>
                          {r.appsCount}
                        </Badge>
                      </td>
                      <td>{bar(r.totalRamMb, r.packRamMb, 'Mo')}</td>
                      <td>{bar(r.totalCpuCores, r.packCpuCores, 'cœurs')}</td>
                      <td>{bar(r.totalStorageGb, r.packStorageGb, 'Go')}</td>
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