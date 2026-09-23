'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { Alert, Badge, Button, PageIntro, PageLoading } from '@/components/ui';
import { useToast } from '@/components/toast';
import { ADMIN_NAV } from '@/config/nav';
import { useAdminSession } from '@/lib/session';
import {
  apiError,
  getReconcileSettings,
  type ReconcileSettingKey,
  type ReconcileSettingSource,
  type ReconcileSettingsView,
} from '@/lib/api';

// 17B.4D-B — page admin READ-ONLY des réglages de réconciliation.
// Affichage uniquement : GET /api/admin/reconcile + « Actualiser ».
// Aucun PATCH, aucun POST /reset, aucun toggle enabled (activation = 17B.4E).

interface SettingMeta {
  key: ReconcileSettingKey;
  label: string;
  help: string;
  unit?: string;
  def: boolean | number;
  min?: number;
  max?: number;
}

/** Bornes/défauts miroir de reconcile-settings.ts — affichage uniquement. */
const MOTEUR: SettingMeta[] = [
  {
    key: 'enabled',
    label: 'Moteur actif',
    help: "Démarre (ou non) le worker qui vérifie périodiquement les déploiements en attente auprès des panels. Lecture seule pendant 17B.4D-B.",
    def: false,
  },
  {
    key: 'scanIntervalMs',
    label: 'Intervalle de scan',
    help: "Délai entre deux cycles d'observation du moteur de réconciliation.",
    unit: 'ms',
    def: 30_000,
    min: 10_000,
    max: 900_000,
  },
  {
    key: 'batchSize',
    label: 'Taille du lot',
    help: "Nombre maximal de candidats traités par cycle de scan.",
    def: 10,
    min: 1,
    max: 100,
  },
];

const LEASE: SettingMeta[] = [
  {
    key: 'leaseMs',
    label: "Durée du lease d'observation",
    help: "Pendant laquelle un cycle claim un candidat ; borne mini garantit lease > durée normale d'une vérification panel.",
    unit: 'ms',
    def: 120_000,
    min: 30_000,
    max: 1_800_000,
  },
  {
    key: 'attemptAlertThreshold',
    label: "Seuil d'alerte des tentatives",
    help: "Nombre de tentatives avant alerte de supervision (mode lent/monitoring) — jamais un arrêt ni un échec définitif.",
    def: 12,
    min: 1,
    max: 100,
  },
];

const BACKOFF: SettingMeta[] = [
  {
    key: 'backoffInitialMs',
    label: 'Backoff initial',
    help: "Délai avant la première reprise après un cycle en échec (palier n=1).",
    unit: 'ms',
    def: 30_000,
    min: 10_000,
    max: 1_800_000,
  },
  {
    key: 'maxBackoffMs',
    label: 'Backoff maximal',
    help: "Plafond du palier de reprise. Doit rester supérieur ou égal au backoff initial.",
    unit: 'ms',
    def: 3_600_000,
    min: 60_000,
    max: 86_400_000,
  },
];

const SOURCE_LABEL: Record<ReconcileSettingSource, string> = {
  DATABASE: 'DATABASE',
  ENV: 'ENV',
  DEFAULT: 'DEFAULT',
};

const SOURCE_TONE: Record<ReconcileSettingSource, 'violet' | 'info' | 'neutral'> = {
  DATABASE: 'violet',
  ENV: 'info',
  DEFAULT: 'neutral',
};

const ss = {
  wrap: { maxWidth: 760 } as React.CSSProperties,
  panelBody: { display: 'flex', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' as const },
  valueCol: { textAlign: 'right' as const, minWidth: 170 },
};

function hasOverride(view: ReconcileSettingsView, key: ReconcileSettingKey): boolean {
  const v = view.overrides[key];
  return v !== undefined && v !== null;
}

function formatValue(meta: SettingMeta, value: boolean | number | null | undefined): string {
  if (value === undefined || value === null) return '—';
  if (meta.key === 'enabled') return value === true ? 'Activé' : 'Désactivé';
  const n = Number(value);
  const base = Number.isFinite(n) ? n.toLocaleString('fr-FR') : String(value);
  return meta.unit ? `${base} ${meta.unit}` : base;
}

function formatMetaDefault(meta: SettingMeta): string {
  return formatValue(meta, meta.def);
}

function formatBounds(meta: SettingMeta): string | null {
  if (meta.min === undefined || meta.max === undefined) return null;
  const unit = meta.unit ? ` ${meta.unit}` : '';
  return `[${meta.min.toLocaleString('fr-FR')} … ${meta.max.toLocaleString('fr-FR')}${unit}]`;
}

function formatStamp(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function countOverrides(view: ReconcileSettingsView): number {
  return (Object.keys(view.overrides) as ReconcileSettingKey[]).filter((k) => hasOverride(view, k)).length;
}

function SettingRow({
  meta,
  view,
}: {
  meta: SettingMeta;
  view: ReconcileSettingsView;
}) {
  const source = view.sources[meta.key] ?? 'DEFAULT';
  const effective = view.effective[meta.key];
  const overridden = hasOverride(view, meta.key);
  const overrideVal = view.overrides[meta.key];
  const bounds = formatBounds(meta);

  return (
    <div className="row" style={ss.panelBody}>
      <div className="flex-1" style={{ minWidth: 220 }}>
        <div className="row" style={{ gap: 8 }}>
          <b style={{ fontSize: 15 }}>{meta.label}</b>
          <Badge tone={SOURCE_TONE[source] ?? 'neutral'}>{SOURCE_LABEL[source] ?? source}</Badge>
          {overridden && <Badge tone="warn">override DB</Badge>}
        </div>
        <p className="muted mt-sm" style={{ fontSize: 13, maxWidth: 460 }}>{meta.help}</p>
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          Défaut : {formatMetaDefault(meta)}
          {bounds ? ` · bornes ${bounds}` : ''}
        </p>
      </div>
      <div style={ss.valueCol}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>
          {formatValue(meta, effective)}
        </div>
        {overridden && (
          <div className="muted" style={{ fontSize: 12 }}>
            override : {formatValue(meta, overrideVal as boolean | number)}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ReconciliationPage() {
  const toast = useToast();
  const { phase, token } = useAdminSession();
  const [view, setView] = useState<ReconcileSettingsView | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    const res = await getReconcileSettings(token);
    setLoading(false);
    if (!res.ok) {
      const msg = apiError(res, 'Lecture des réglages impossible.');
      setLoadError(msg);
      toast.error(msg);
      return;
    }
    setLoadError(null);
    setView(res.data as ReconcileSettingsView);
  }, [token, toast]);

  useEffect(() => {
    if (phase === 'ready') void load();
  }, [phase, load]);

  if (phase === 'loading' || (phase === 'ready' && !view && !loadError)) {
    return <PageLoading label="Chargement des réglages de réconciliation…" />;
  }
  if (phase === 'denied' || !token) {
    return (
      <AppShell me={null} nav={ADMIN_NAV} bare={false}>
        <div className="wrap-md">
          <Alert tone="error" title="Accès refusé">Réservé aux administrateurs.</Alert>
        </div>
      </AppShell>
    );
  }

  const v = view;
  const enabledMeta = MOTEUR[0];
  const enabledSource = v ? (v.sources.enabled ?? 'DEFAULT') : 'DEFAULT';
  const enabledEffective = v ? v.effective.enabled : enabledMeta.def;
  const enabledOverridden = v ? hasOverride(v, 'enabled') : false;
  const overrideCount = v ? countOverrides(v) : 0;
  const totalKeys = 7;

  return (
    <AppShell me={{ email: 'admin', role: 'ADMIN' }} nav={ADMIN_NAV}>
      <div className="wrap-md" style={ss.wrap}>
        <PageIntro
          eyebrow="Administration · Réconciliation"
          title="Réglages de réconciliation"
          sub="Le moteur vérifie les déploiements en attente auprès des panels et signale les écarts. Cette page affiche la configuration effective, sa source (base, variables d'environnement ou défauts) et les éventuels overrides administrés."
        />

        <Alert tone="info" title="Lecture seule (17B.4D-B)">
          Cette page est strictement en lecture seule dans la sous-phase actuelle : aucun réglage ne peut
          encore être modifié depuis l'interface. L'activation live du moteur sera disponible uniquement
          pendant la validation contrôlée de la phase 17B.4E.
        </Alert>

        {loadError && !v && (
          <Alert tone="error" title="Erreur de chargement">{loadError}</Alert>
        )}

        {v && (
          <>
            {/* ── Résumé ──────────────────────────────────────────────────── */}
            <div className="panel mt">
              <div className="panel-head">
                <b>Résumé</b>
                <div className="row" style={{ gap: 6 }}>
                  <Badge tone={enabledEffective === true ? 'ok' : 'neutral'}>
                    {enabledEffective === true ? 'Activé' : 'Désactivé'}
                  </Badge>
                  <Badge tone={overrideCount > 0 ? 'warn' : 'neutral'}>
                    {overrideCount} override{overrideCount > 1 ? 's' : ''} / {totalKeys}
                  </Badge>
                </div>
              </div>
              <div className="panel-body stack" style={{ gap: 8 }}>
                <div className="row" style={{ gap: 16, flexWrap: 'wrap', fontSize: 13 }}>
                  <span className="muted">
                    Dernière modification : <b style={{ color: 'var(--text-primary)' }}>{formatStamp(v.updatedAt)}</b>
                  </span>
                  <span className="muted">
                    Créé le : <b style={{ color: 'var(--text-primary)' }}>{formatStamp(v.createdAt)}</b>
                  </span>
                </div>
                <p className="muted" style={{ fontSize: 12 }}>
                  {overrideCount === 0
                    ? 'Aucun override en base : toutes les valeurs proviennent des variables d\'environnement ou des défauts du code.'
                    : `${overrideCount} valeur${overrideCount > 1 ? 'x' : ''} surchargée${overrideCount > 1 ? 's' : ''} en base (badge « override DB » ci-dessous).`}
                </p>
              </div>
            </div>

            {/* ── Moteur ──────────────────────────────────────────────────── */}
            <div className="panel mt">
              <div className="panel-head"><b>Moteur</b></div>
              <div className="panel-body stack" style={{ gap: 14 }}>
                {/* enabled — strictement lecture seule */}
                <div className="row" style={ss.panelBody}>
                  <div className="flex-1" style={{ minWidth: 220 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <b style={{ fontSize: 15 }}>{enabledMeta.label}</b>
                      <Badge tone={SOURCE_TONE[enabledSource] ?? 'neutral'}>
                        {SOURCE_LABEL[enabledSource] ?? enabledSource}
                      </Badge>
                      {enabledOverridden && <Badge tone="warn">override DB</Badge>}
                      <Badge tone={enabledEffective === true ? 'ok' : 'neutral'}>
                        {enabledEffective === true ? 'Activé' : 'Désactivé'}
                      </Badge>
                    </div>
                    <p className="muted mt-sm" style={{ fontSize: 13, maxWidth: 460 }}>
                      {enabledMeta.help}
                    </p>
                    <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                      Défaut : {formatMetaDefault(enabledMeta)}
                    </p>
                    <Alert tone="warn" title="Activation verrouillée">
                      L'activation sera disponible uniquement pendant la validation contrôlée de la phase 17B.4E.
                    </Alert>
                  </div>
                  <div style={ss.valueCol}>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>
                      {enabledEffective === true ? 'Activé' : 'Désactivé'}
                    </div>
                    {enabledOverridden && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        override : {v.overrides.enabled === true ? 'Activé' : 'Désactivé'}
                      </div>
                    )}
                    <div className="muted" style={{ fontSize: 12 }}>
                      lecture seule
                    </div>
                  </div>
                </div>

                {MOTEUR.slice(1).map((m) => (
                  <SettingRow key={m.key} meta={m} view={v} />
                ))}
              </div>
            </div>

            {/* ── Lease et tentatives ─────────────────────────────────────── */}
            <div className="panel mt">
              <div className="panel-head"><b>Lease et tentatives</b></div>
              <div className="panel-body stack" style={{ gap: 14 }}>
                {LEASE.map((m) => (
                  <SettingRow key={m.key} meta={m} view={v} />
                ))}
              </div>
            </div>

            {/* ── Backoff ─────────────────────────────────────────────────── */}
            <div className="panel mt">
              <div className="panel-head"><b>Backoff</b></div>
              <div className="panel-body stack" style={{ gap: 14 }}>
                {BACKOFF.map((m) => (
                  <SettingRow key={m.key} meta={m} view={v} />
                ))}
              </div>
            </div>

            {/* ── Actions (lecture seule) ─────────────────────────────────── */}
            <div className="row mt" style={{ gap: 10, flexWrap: 'wrap' }}>
              <Button variant="secondary" onClick={() => void load()} disabled={loading} busy={loading}>
                {loading ? 'Actualisation…' : 'Actualiser'}
              </Button>
              <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>
                Écriture des réglages : 17B.4D-C — activation live : 17B.4E.
              </span>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
