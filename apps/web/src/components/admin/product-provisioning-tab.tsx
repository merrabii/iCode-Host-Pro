'use client';

import { useEffect, useState } from 'react';
import {
  apiError,
  getProductProvisioning,
  listProvisionMethods,
  updateProduct,
  type ProvisionMethod,
} from '@/lib/api';
import { useToast } from '@/components/toast';
import { Badge, Button, Field, Panel, Select } from '@/components/ui';

interface DeploymentModuleView {
  id: string;
  code: string;
  name: string;
  kind?: string | null;
  server?: { id: string; hostname: string } | null;
}
interface ProvisioningSummary {
  deploymentModule: DeploymentModuleView | null;
  provisionMethod: ProvisionMethod | null;
  moduleParams: Record<string, unknown>;
}

/** Onglet « Provisioning » — résumé lecture seule de la méthode de déploiement
 *  (produit → pack → module → serveur) + choix de la méthode de provisioning. */
export function ProductProvisioningTab({
  productId,
  token,
  onUpdated,
}: {
  productId: string;
  token: string;
  onUpdated?: () => void;
}) {
  const toast = useToast();
  const [summary, setSummary] = useState<ProvisioningSummary | null>(null);
  const [methods, setMethods] = useState<ProvisionMethod[]>([]);
  const [mode, setMode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const [s, m] = await Promise.all([getProductProvisioning(token, productId), listProvisionMethods(token)]);
    if (s.ok) {
      const data = s.data as ProvisioningSummary;
      setSummary(data);
      setMode(data.provisionMethod?.id ?? null);
    }
    if (m.ok) setMethods((m.data as ProvisionMethod[]) ?? []);
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  async function saveMethod() {
    if (!mode) return toast.error('Choisissez une méthode de provisioning.');
    setBusy(true);
    const r = await updateProduct(token, productId, { provisionModuleId: mode });
    setBusy(false);
    if (!r.ok) return toast.error(apiError(r, 'Échec de l’enregistrement de la méthode.'));
    toast.ok('Méthode de provisioning mise à jour.');
    onUpdated?.();
    await load();
  }

  const mod = summary?.deploymentModule;
  const row = (k: string, v: React.ReactNode) => (
    <div className="row" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border-soft)' }}>
      <span className="muted" style={{ fontSize: 13 }}>{k}</span>
      <span style={{ fontSize: 13 }}>{v}</span>
    </div>
  );

  return (
    <Panel
      title="Mise à disposition (provisioning)"
      sub="Comment le produit est déployé : le module du pack sert l'app, une méthode crée la ressource."
      className="mb"
    >
      <div className="section-title">
        <h3>Chaîne de déploiement</h3>
        <span className="muted" style={{ fontSize: 12 }}>Vient du pack sélectionné à l'onglet Général.</span>
      </div>
      <div className="stack" style={{ gap: 0 }}>
        {row('Module de déploiement', mod ? `${mod.code} · ${mod.name}` : <span className="muted">—</span>)}
        {row('Type', mod?.kind ? (mod.kind === 'SHARED_PROJECT' ? 'A · projet partagé' : 'B · projet client dédié') : <span className="muted">—</span>)}
        {row('Serveur', mod?.server?.hostname ?? <span className="muted">—</span>)}
      </div>

      <div className="section-title" style={{ marginTop: 18 }}>
        <h3>Méthode de provisioning</h3>
        <span className="muted" style={{ fontSize: 12 }}>Module qui crée l'app du client à la première commande.</span>
      </div>
      {summary?.provisionMethod ? (
        <div className="stack" style={{ gap: 6, marginBottom: 12 }}>
          <Badge tone="green">{summary.provisionMethod.name}</Badge>
          {summary.provisionMethod.code && (
            <div className="muted mono" style={{ fontSize: 12 }}>code : {summary.provisionMethod.code}</div>
          )}
          {summary.provisionMethod.description && (
            <div className="muted" style={{ fontSize: 13 }}>{summary.provisionMethod.description}</div>
          )}
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>Aucune méthode active définie.</div>
      )}

      {methods.length > 0 && (
        <>
          <Field label="Changer de méthode">
            <Select value={mode ?? ''} onChange={(e) => setMode(e.target.value)}>
              <option value="">— Choisir —</option>
              {methods.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </Select>
          </Field>
          <div className="grid-form-actions" style={{ marginTop: 10 }}>
            <Button onClick={saveMethod} disabled={busy || !mode}>
              {busy ? 'Enregistrement…' : 'Enregistrer la méthode'}
            </Button>
          </div>
        </>
      )}
    </Panel>
  );
}

export default ProductProvisioningTab;