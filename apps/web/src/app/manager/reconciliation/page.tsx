'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { Alert, Badge, Button, PageIntro, PageLoading } from '@/components/ui';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useToast } from '@/components/toast';
import { ADMIN_NAV } from '@/config/nav';
import { useAdminSession } from '@/lib/session';
import {
  apiError,
  getReconcileSettings,
  updateReconcileSettings,
  type ReconcileNumericSettingKey,
  type ReconcileNumericSettingsPatch,
  type ReconcileSettingKey,
  type ReconcileSettingSource,
  type ReconcileSettingsView,
} from '@/lib/api';

// 17B.4D-C — édition SÉCURISÉE des SIX paramètres numériques des réglages de
// réconciliation. `enabled` reste strictement en lecture seule (activation
// exclusive de 17B.4E). Écriture = UNIQUEMENT PATCH /api/admin/reconcile via
// updateReconcileSettings, payload construit à partir de NUMERIC_KEYS (jamais
// enabled, jamais de spread de view.effective, jamais de POST /reset).

interface SettingMeta {
  key: ReconcileSettingKey;
  label: string;
  help: string;
  unit?: string;
  def: boolean | number;
  min?: number;
  max?: number;
}

/** Métadonnées d'un paramètre NUMÉRIQUE éditable (bornes strictes). */
interface NumericMeta {
  key: ReconcileNumericSettingKey;
  label: string;
  help: string;
  unit?: string;
  def: number;
  min: number;
  max: number;
}

/** Liste constante des SEULES clés envoyées en PATCH (sécurité structurelle :
 *  `enabled` n'appartient pas à ce type et ne peut donc jamais figurer dedans). */
const NUMERIC_KEYS: readonly ReconcileNumericSettingKey[] = [
  'scanIntervalMs',
  'batchSize',
  'leaseMs',
  'attemptAlertThreshold',
  'backoffInitialMs',
  'maxBackoffMs',
];

/** enabled — lecture seule, affichage uniquement (aucun input/switch/onChange). */
const ENABLED_META: SettingMeta = {
  key: 'enabled',
  label: 'Moteur actif',
  help: "Démarre (ou non) le worker qui vérifie périodiquement les déploiements en attente auprès des panels. Lecture seule : activation réservée à la phase 17B.4E.",
  def: false,
};

/** Bornes/défauts miroir de reconcile-settings.ts — validation + affichage. */
const MOTEUR: NumericMeta[] = [
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

const LEASE: NumericMeta[] = [
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

const BACKOFF: NumericMeta[] = [
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

const ALL_NUMERIC: NumericMeta[] = [...MOTEUR, ...LEASE, ...BACKOFF];

const META_BY_KEY = new Map<ReconcileNumericSettingKey, NumericMeta>(
  ALL_NUMERIC.map((m) => [m.key, m]),
);

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

/** Brouillon local : absent = inchangé ; null = retrait d'override en attente
 *  (« Rétablir la valeur héritée ») ; string = saisie de l'input. */
type NumericDraft = Partial<Record<ReconcileNumericSettingKey, string | null>>;

const ss = {
  wrap: { maxWidth: 760 } as React.CSSProperties,
  panelBody: { display: 'flex', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' as const },
  valueCol: { textAlign: 'right' as const, minWidth: 230 },
};

function hasOverride(view: ReconcileSettingsView, key: ReconcileSettingKey): boolean {
  const v = view.overrides[key];
  return v !== undefined && v !== null;
}

function formatValue(meta: { key: ReconcileSettingKey; unit?: string }, value: boolean | number | null | undefined): string {
  if (value === undefined || value === null) return '—';
  if (meta.key === 'enabled') return value === true ? 'Activé' : 'Désactivé';
  const n = Number(value);
  const base = Number.isFinite(n) ? n.toLocaleString('fr-FR') : String(value);
  return meta.unit ? `${base} ${meta.unit}` : base;
}

function formatMetaDefault(meta: { def: boolean | number; unit?: string; key: ReconcileSettingKey }): string {
  return formatValue(meta, meta.def);
}

function formatBounds(meta: { min?: number; max?: number; unit?: string }): string | null {
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

/** Une clé du brouillon est-elle réellement modifiée par rapport à l'effectif ? */
function isDraftDirty(view: ReconcileSettingsView, draft: NumericDraft, key: ReconcileNumericSettingKey): boolean {
  const d = draft[key];
  if (d === undefined) return false;
  if (d === null) return hasOverride(view, key); // retrait sans override = no-op
  const n = Number(d.trim());
  if (!Number.isFinite(n)) return true; // saisie invalide : à corriger, donc « modifiée »
  return n !== Number(view.effective[key]);
}

/** Valeur RÉSULTANTE après application du brouillon — null = inconnue côté client
 *  (retrait d'override : la valeur viendra de ENV/DEFAULT, non lue ici). */
function resultingValue(
  view: ReconcileSettingsView,
  draft: NumericDraft,
  key: ReconcileNumericSettingKey,
): number | null {
  const d = draft[key];
  if (d === undefined) return Number(view.effective[key]);
  if (d === null) return hasOverride(view, key) ? null : Number(view.effective[key]);
  const n = Number(d.trim());
  return Number.isFinite(n) ? n : null;
}

/** Validation LOCALE avant PATCH — renvoie le message d'erreur français ou null.
 *  Le backend reste l'autorité finale (dont ENV inconnu du brouillon). */
function validateDraft(view: ReconcileSettingsView, draft: NumericDraft): {
  fieldErrors: Partial<Record<ReconcileNumericSettingKey, string>>;
  formError: string | null;
} {
  const fieldErrors: Partial<Record<ReconcileNumericSettingKey, string>> = {};
  for (const key of NUMERIC_KEYS) {
    const d = draft[key];
    if (d === undefined || d === null) continue;
    const meta = META_BY_KEY.get(key)!;
    const raw = d.trim();
    if (raw === '') {
      fieldErrors[key] = 'Valeur requise.';
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      fieldErrors[key] = 'Nombre invalide.';
      continue;
    }
    if (!Number.isInteger(n)) {
      fieldErrors[key] = 'La valeur doit être un entier.';
      continue;
    }
    if (n < meta.min || n > meta.max) {
      fieldErrors[key] = `Valeur hors bornes [${meta.min.toLocaleString('fr-FR')} … ${meta.max.toLocaleString('fr-FR')}${meta.unit ? ` ${meta.unit}` : ''}].`;
      continue;
    }
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors, formError: 'Correction requise avant enregistrement.' };
  }
  // Contrainte croisée uniquement lorsque les deux valeurs résultantes sont connues.
  const initial = resultingValue(view, draft, 'backoffInitialMs');
  const max = resultingValue(view, draft, 'maxBackoffMs');
  if (initial !== null && max !== null && max < initial) {
    return {
      fieldErrors,
      formError: `Le backoff maximal (${max.toLocaleString('fr-FR')} ms) doit être supérieur ou égal au backoff initial (${initial.toLocaleString('fr-FR')} ms).`,
    };
  }
  return { fieldErrors, formError: null };
}

/** PATCH PARTIEL : uniquement les clés du brouillon réellement modifiées,
 *  construites à partir de NUMERIC_KEYS — jamais `enabled`, jamais de spread. */
function buildPatch(view: ReconcileSettingsView, draft: NumericDraft): ReconcileNumericSettingsPatch {
  const patch: ReconcileNumericSettingsPatch = {};
  for (const key of NUMERIC_KEYS) {
    if (!isDraftDirty(view, draft, key)) continue;
    const d = draft[key];
    if (d === null) {
      patch[key] = null;
      continue;
    }
    patch[key] = Number((d as string).trim());
  }
  return patch;
}

function NumericRow({
  meta,
  view,
  draft,
  fieldError,
  disabled,
  onDraftChange,
  onRestore,
}: {
  meta: NumericMeta;
  view: ReconcileSettingsView;
  draft: NumericDraft;
  fieldError?: string;
  disabled: boolean;
  onDraftChange: (key: ReconcileNumericSettingKey, value: string) => void;
  onRestore: (key: ReconcileNumericSettingKey) => void;
}) {
  const source = view.sources[meta.key] ?? 'DEFAULT';
  const effective = Number(view.effective[meta.key]);
  const overridden = hasOverride(view, meta.key);
  const d = draft[meta.key];
  const pendingClear = d === null;
  const dirty = isDraftDirty(view, draft, meta.key);
  const bounds = formatBounds(meta);
  const inputValue = pendingClear ? '' : (d ?? String(effective));
  const restoreDisabled =
    disabled || pendingClear || (!overridden && d === undefined);

  return (
    <div className="row" style={ss.panelBody}>
      <div className="flex-1" style={{ minWidth: 220 }}>
        <div className="row" style={{ gap: 8 }}>
          <b style={{ fontSize: 15 }}>{meta.label}</b>
          <Badge tone={SOURCE_TONE[source] ?? 'neutral'}>{SOURCE_LABEL[source] ?? source}</Badge>
          {overridden && <Badge tone="warn">override DB</Badge>}
          {dirty && <Badge tone="cyan">{pendingClear ? 'retrait en attente' : 'modifié'}</Badge>}
        </div>
        <p className="muted mt-sm" style={{ fontSize: 13, maxWidth: 460 }}>{meta.help}</p>
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          Défaut : {formatValue(meta, meta.def)}
          {bounds ? ` · bornes ${bounds}` : ''}
        </p>
        <p className="muted" style={{ fontSize: 12, marginTop: 2 }}>
          Effectif actuel : <b style={{ color: 'var(--text-primary)' }}>{formatValue(meta, effective)}</b>
        </p>
      </div>
      <div style={ss.valueCol}>
        <div className="row" style={{ gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
          <input
            className="input"
            type="number"
            min={meta.min}
            max={meta.max}
            step={1}
            value={inputValue}
            placeholder={pendingClear ? `Héritée : ${formatValue(meta, effective)}` : ''}
            disabled={disabled}
            aria-label={meta.label}
            style={{ width: 170, textAlign: 'right' }}
            onChange={(e) => onDraftChange(meta.key, e.target.value)}
          />
          {meta.unit && <span className="muted" style={{ fontSize: 12 }}>{meta.unit}</span>}
        </div>
        {fieldError && (
          <div style={{ color: 'var(--danger, #d33)', fontSize: 12, marginTop: 4 }} role="alert">
            {fieldError}
          </div>
        )}
        {pendingClear && (
          <div className="muted" style={{ fontSize: 12, marginTop: 4, maxWidth: 230, marginLeft: 'auto' }}>
            Retrait en attente : la valeur héritée viendra de ENV ou DEFAULT après enregistrement.
          </div>
        )}
        <div style={{ marginTop: 6 }}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRestore(meta.key)}
            disabled={restoreDisabled}
          >
            Rétablir la valeur héritée
          </Button>
        </div>
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
  const [draft, setDraft] = useState<NumericDraft>({});
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<ReconcileNumericSettingKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await getReconcileSettings(token);
      if (!res.ok) {
        const msg = apiError(res, 'Lecture des réglages impossible.');
        setLoadError(msg);
        toast.error(msg);
        return;
      }
      setLoadError(null);
      setView(res.data as ReconcileSettingsView);
      setDraft({});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLoadError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [token, toast]);

  useEffect(() => {
    if (phase === 'ready') void load();
  }, [phase, load]);

  const dirtyKeys = useMemo(
    () => (view ? NUMERIC_KEYS.filter((k) => isDraftDirty(view, draft, k)) : []),
    [view, draft],
  );
  const dirty = dirtyKeys.length > 0;
  const busy = saving || loading;

  function onDraftChange(key: ReconcileNumericSettingKey, value: string) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
    setFormError(null);
  }

  function onRestore(key: ReconcileNumericSettingKey) {
    setDraft((prev) => ({ ...prev, [key]: null }));
    setFieldErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
    setFormError(null);
  }

  async function save() {
    if (!token || !view || saving) return;
    setFormError(null);
    const { fieldErrors: errs, formError: ferr } = validateDraft(view, draft);
    if (ferr) {
      setFieldErrors(errs);
      setFormError(ferr);
      toast.error(ferr);
      return; // aucun appel API si la validation locale échoue
    }
    setFieldErrors({});
    const patch = buildPatch(view, draft);
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    try {
      const res = await updateReconcileSettings(token, patch);
      if (!res.ok) {
        const msg = apiError(res, "Enregistrement des réglages impossible.");
        setFormError(msg);
        toast.error(msg);
        await load(); // resynchronisation : ne jamais supposer qu'une écriture a réussi
        return;
      }
      const data = res.data as ReconcileSettingsView;
      setView(data);
      setDraft({}); // brouillon reconstruit depuis les valeurs effectives reçues
      setFieldErrors({});
      setFormError(null);
      toast.ok('Paramètres de réconciliation enregistrés.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setFormError(msg);
      toast.error(msg);
      await load(); // erreur réseau : resynchroniser l'état réel
    } finally {
      setSaving(false);
    }
  }

  async function resetNumeric() {
    if (!token || saving) return;
    const patch: ReconcileNumericSettingsPatch = {};
    for (const key of NUMERIC_KEYS) patch[key] = null; // exactement les six clés — jamais enabled
    setSaving(true);
    try {
      const res = await updateReconcileSettings(token, patch);
      if (!res.ok) {
        const msg = apiError(res, 'Réinitialisation impossible.');
        setFormError(msg);
        toast.error(msg);
        setConfirmReset(false);
        await load();
        return;
      }
      const data = res.data as ReconcileSettingsView;
      setView(data);
      setDraft({});
      setFieldErrors({});
      setFormError(null);
      setConfirmReset(false);
      toast.ok('Paramètres numériques réinitialisés (retour ENV/DEFAULT).');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setFormError(msg);
      toast.error(msg);
      setConfirmReset(false);
      await load();
    } finally {
      setSaving(false);
    }
  }

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
  const enabledMeta = ENABLED_META;
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
          sub="Le moteur vérifie les déploiements en attente auprès des panels et signale les écarts. Cette page affiche la configuration effective, sa source (base, variables d'environnement ou défauts), permet d'éditer les six paramètres numériques et de retirer leurs overrides."
        />

        <Alert tone="info" title="Édition des paramètres numériques (17B.4D-C)">
          Les six paramètres numériques sont éditables (brouillon local, puis « Enregistrer »).
          Le champ « Moteur actif » (enabled) reste strictement en lecture seule : aucun payload
          enabled n'est jamais envoyé. L'activation sera disponible uniquement pendant la
          validation contrôlée de la phase 17B.4E.
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
                  <Badge tone={dirty ? 'cyan' : 'neutral'}>
                    {dirty
                      ? `${dirtyKeys.length} modification${dirtyKeys.length > 1 ? 's' : ''} en attente`
                      : 'aucune modification'}
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
                {/* enabled — strictement lecture seule : aucun input, aucun onChange */}
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

                {MOTEUR.map((m) => (
                  <NumericRow
                    key={m.key}
                    meta={m}
                    view={v}
                    draft={draft}
                    fieldError={fieldErrors[m.key]}
                    disabled={busy}
                    onDraftChange={onDraftChange}
                    onRestore={onRestore}
                  />
                ))}
              </div>
            </div>

            {/* ── Lease et tentatives ─────────────────────────────────────── */}
            <div className="panel mt">
              <div className="panel-head"><b>Lease et tentatives</b></div>
              <div className="panel-body stack" style={{ gap: 14 }}>
                {LEASE.map((m) => (
                  <NumericRow
                    key={m.key}
                    meta={m}
                    view={v}
                    draft={draft}
                    fieldError={fieldErrors[m.key]}
                    disabled={busy}
                    onDraftChange={onDraftChange}
                    onRestore={onRestore}
                  />
                ))}
              </div>
            </div>

            {/* ── Backoff ─────────────────────────────────────────────────── */}
            <div className="panel mt">
              <div className="panel-head"><b>Backoff</b></div>
              <div className="panel-body stack" style={{ gap: 14 }}>
                {BACKOFF.map((m) => (
                  <NumericRow
                    key={m.key}
                    meta={m}
                    view={v}
                    draft={draft}
                    fieldError={fieldErrors[m.key]}
                    disabled={busy}
                    onDraftChange={onDraftChange}
                    onRestore={onRestore}
                  />
                ))}
              </div>
            </div>

            {formError && (
              <div className="mt">
                <Alert tone="error" title="Enregistrement / validation">{formError}</Alert>
              </div>
            )}

            {/* ── Actions ─────────────────────────────────────────────────── */}
            <div className="row mt" style={{ gap: 10, flexWrap: 'wrap' }}>
              <Button
                onClick={() => void save()}
                disabled={busy || !dirty}
                busy={saving}
              >
                {saving ? 'Enregistrement…' : 'Enregistrer'}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setFieldErrors({});
                  setFormError(null);
                  void load();
                }}
                disabled={busy}
                busy={loading && !saving}
              >
                {loading && !saving ? 'Actualisation…' : 'Actualiser'}
              </Button>
              <Button
                variant="danger"
                onClick={() => setConfirmReset(true)}
                disabled={busy}
              >
                Réinitialiser les paramètres numériques
              </Button>
              <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>
                {dirty
                  ? `${dirtyKeys.length} clé${dirtyKeys.length > 1 ? 's' : ''} en attente d'enregistrement (PATCH partiel).`
                  : 'Aucune modification en attente. Écriture = PATCH admin officiel uniquement.'}
              </span>
            </div>

            {confirmReset && (
              <ConfirmDialog
                title="Réinitialiser les paramètres numériques ?"
                message={
                  'Les SIX paramètres numériques repasseront en valeur héritée (ENV ou DEFAULT) ' +
                  'via un PATCH contenant null pour chacune. Le champ enabled n\'est pas concerné ' +
                  '(aucun enabled ne sera envoyé).'
                }
                confirmLabel="Réinitialiser"
                busy={saving}
                onConfirm={() => void resetNumeric()}
                onCancel={() => {
                  if (!saving) setConfirmReset(false);
                }}
              />
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
