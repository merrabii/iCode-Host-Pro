'use client';

import { useEffect, useState } from 'react';
import {
  apiError,
  deleteFreeSubdomainRule,
  getFreeSubdomainRule,
  listCloudflareDomains,
  upsertFreeSubdomainRule,
  type CloudflareDomain,
  type FreeSubdomainRuleAdmin,
} from '@/lib/api';
import { useToast } from '@/components/toast';
import { Alert, Button, Field, Input, Panel } from '@/components/ui';
import { IconPlus, IconTrash, IconX } from '@/components/icons';

const EMPTY: Omit<FreeSubdomainRuleAdmin, 'id'> = {
  minLength: 3,
  maxLength: 40,
  allowedChars: null,
  reservedPrefixes: [],
  rejectPattern: null,
  allowedDomainIds: [],
};

/** Onglet « Sous-domaines gratuits » — règle de sous-domaines d'un produit (1:1). */
export function ProductSubdomainTab({
  productId,
  token,
  onUpdated,
}: {
  productId: string;
  token: string;
  onUpdated?: () => void;
}) {
  const toast = useToast();
  const [rule, setRule] = useState<FreeSubdomainRuleAdmin | null>(null);
  const [domains, setDomains] = useState<CloudflareDomain[]>([]);
  const [minL, setMinL] = useState(EMPTY.minLength);
  const [maxL, setMaxL] = useState(EMPTY.maxLength);
  const [chars, setChars] = useState(EMPTY.allowedChars ?? '');
  const [prefixes, setPrefixes] = useState<string[]>(EMPTY.reservedPrefixes);
  const [allowed, setAllowed] = useState<string[]>(EMPTY.allowedDomainIds);
  const [pattern, setPattern] = useState(EMPTY.rejectPattern ?? '');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [pfx, setPfx] = useState('');

  async function load() {
    setLoading(true);
    const [r, d] = await Promise.all([getFreeSubdomainRule(token, productId), listCloudflareDomains(token)]);
    if (r.ok && r.data && typeof r.data === 'object' && 'minLength' in (r.data as object)) {
      const g = r.data as FreeSubdomainRuleAdmin;
      setRule(g);
      setMinL(g.minLength);
      setMaxL(g.maxLength);
      setChars(g.allowedChars ?? '');
      setPrefixes(g.reservedPrefixes ?? []);
      setAllowed(g.allowedDomainIds ?? []);
      setPattern(g.rejectPattern ?? '');
    } else {
      setRule(null);
      setPrefixes([]);
      setAllowed([]);
    }
    if (d.ok) setDomains((d.data as CloudflareDomain[]) ?? []);
    setLoading(false);
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  const activeDomains = domains.filter((dm) => dm.status === 'ACTIVE');

  function toggleDomain(id: string) {
    setAllowed((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function addPrefix() {
    const v = pfx.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!v) return;
    setPrefixes((prev) => (prev.includes(v) ? prev : [...prev, v]));
    setPfx('');
  }

  async function save() {
    if (minL > maxL) return toast.error('La longueur minimale doit être ≤ la maximale.');
    if (allowed.length === 0) return toast.error('Choisissez au moins un domaine racine autorisé.');
    setBusy('save');
    const r = await upsertFreeSubdomainRule(token, productId, {
      minLength: minL,
      maxLength: maxL,
      allowedChars: chars.trim() || null,
      reservedPrefixes: prefixes,
      rejectPattern: pattern.trim() || null,
      allowedDomainIds: allowed,
    });
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de l’enregistrement de la règle.'));
    toast.ok('Règle de sous-domaines enregistrée.');
    onUpdated?.();
    await load();
  }

  async function remove() {
    if (!window.confirm('Supprimer la règle de sous-domaines gratuits de ce produit ?')) return;
    setBusy('del');
    const r = await deleteFreeSubdomainRule(token, productId);
    setBusy(null);
    if (!r.ok) return toast.error(apiError(r, 'Échec de la suppression.'));
    toast.ok('Règle supprimée.');
    await load();
  }

  if (loading) {
    return (
      <Panel title="Sous-domaines gratuits" className="mb" sub="Chargement…">
        <div className="muted">Chargement de la règle…</div>
      </Panel>
    );
  }

  return (
    <Panel
      title="Sous-domaines gratuits"
      sub="Contraintes du sous-domaine offert aux clients (Plan Gratuit / domaines de la fiche vitrine)."
      className="mb"
    >
      {!rule && (
        <Alert tone="info">
          Aucune règle définie pour ce produit. En créer une active le choix d'un sous-domaine client.
        </Alert>
      )}

      <div className="grid-form">
        <Field label="Longueur min.">
          <Input type="number" value={minL} min={1} max={60} onChange={(e) => setMinL(Number(e.target.value) || 1)} />
        </Field>
        <Field label="Longueur max.">
          <Input type="number" value={maxL} min={2} max={80} onChange={(e) => setMaxL(Number(e.target.value) || 2)} />
        </Field>
        <Field label="Caractères autorisés" hint="Vide = alphanumérique + tiret par défaut">
          <Input value={chars} onChange={(e) => setChars(e.target.value)} placeholder="a-z0-9-" />
        </Field>
        <Field label="Motif à rejeter (regex)" hint="ex. (?i)admin">
          <Input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="(?i)(admin|test)" />
        </Field>
      </div>

      {/* Préfixes réservés */}
      <div className="section-title" style={{ marginTop: 18 }}>
        <h3>Préfixes réservés</h3>
        <span className="muted" style={{ fontSize: 12 }}>Sous-domaines interdits (ex. admin, api).</span>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {prefixes.map((p) => (
          <span
            key={p}
            className="chip"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--border-soft)', padding: '4px 8px', borderRadius: 999, fontSize: 12 }}
          >
            {p}
            <button type="button" onClick={() => setPrefixes((prev) => prev.filter((x) => x !== p))} style={{ border: 0, background: 'none', cursor: 'pointer', opacity: 0.6 }}>
              <IconX size={12} />
            </button>
          </span>
        ))}
        <span className="row" style={{ gap: 6 }}>
          <Input
            className="input-sm"
            value={pfx}
            onChange={(e) => setPfx(e.target.value.toLowerCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addPrefix();
              }
            }}
            placeholder="admin"
            style={{ width: 120 }}
          />
          <Button size="sm" variant="secondary" onClick={addPrefix}>
            <IconPlus size={12} /> Ajouter
          </Button>
        </span>
      </div>

      {/* Domaines racines autorisés */}
      <div className="section-title" style={{ marginTop: 18 }}>
        <h3>Domaines racines autorisés</h3>
        <span className="muted" style={{ fontSize: 12 }}>Sous le(s)quel(s) le sous-domaine client est créé.</span>
      </div>
      {activeDomains.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>
          Aucun domaine racine actif. Ajoutez-en un sur la page Cloudflare / domaines.
        </div>
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          {activeDomains.map((dm) => (
            <label key={dm.id} className="check-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={allowed.includes(dm.id)}
                onChange={() => toggleDomain(dm.id)}
              />
              <span style={{ fontSize: 13 }}>
                {dm.name} {dm.isRoot && <span className="muted">(racine)</span>}
              </span>
            </label>
          ))}
        </div>
      )}

      <div className="grid-form-actions" style={{ marginTop: 18 }}>
        <Button onClick={save} disabled={busy === 'save' || activeDomains.length === 0}>
          {busy === 'save' ? 'Enregistrement…' : rule ? 'Enregistrer la règle' : 'Créer la règle'}
        </Button>
        {rule && (
          <Button variant="danger" disabled={busy === 'del'} onClick={remove}>
            <IconTrash size={14} /> Supprimer la règle
          </Button>
        )}
      </div>
    </Panel>
  );
}

export default ProductSubdomainTab;