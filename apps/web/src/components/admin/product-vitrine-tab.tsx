'use client';

import { useEffect, useState } from 'react';
import {
  apiError,
  updateProduct,
  type ProductAdmin,
  type ProductPatchInput,
} from '@/lib/api';
import { useToast } from '@/components/toast';
import { Button, Field, Input, Panel, Select } from '@/components/ui';

const BILLING_CYCLES = ['MONTHLY', 'YEARLY', 'ONETIME'] as const;
const CYCLE_LABEL: Record<string, string> = {
  MONTHLY: '/mois',
  YEARLY: '/an',
  ONETIME: 'paiement unique',
};

/** Centimes → saisie en dollars (l'admin tape des prix décimaux). */
function dollars(v?: number | null): string {
  return v == null || Number.isNaN(v) ? '' : (v / 100).toFixed(2);
}
/** Saisie dollars → centimes ('' → null pour effacer). */
function toCents(s: string): number | null {
  if (s.trim() === '') return null;
  const n = Math.round(parseFloat(s.replace(',', '.')) * 100);
  return Number.isFinite(n) ? n : null;
}

/** Onglet « Vitrine » — champs store-front du produit (Bloc A). */
export function ProductVitrineTab({
  product,
  token,
  onUpdated,
  onDirtyChange,
}: {
  product: ProductAdmin;
  token: string;
  onUpdated?: () => void;
  onDirtyChange?: (key: string, dirty: boolean) => void;
}) {
  const toast = useToast();
  const [slug, setSlug] = useState(product.slug ?? '');
  const [slogan, setSlogan] = useState(product.slogan ?? '');
  const [shortDesc, setShortDesc] = useState(product.shortDescription ?? '');
  const [description, setDescription] = useState(product.description ?? '');
  const [color, setColor] = useState(product.color ?? '');
  const [hidden, setHidden] = useState(!!product.hidden);
  const [displayOrder, setDisplayOrder] = useState(product.displayOrder ?? 0);
  const [price, setPrice] = useState(dollars(product.priceHtCents));
  const [promo, setPromo] = useState(dollars(product.promoPriceHtCents));
  const [cycle, setCycle] = useState(product.billingCycle ?? 'MONTHLY');
  const [domainRequired, setDomainRequired] = useState(!!product.domainRequired);
  const [welcomeTemplate, setWelcomeTemplate] = useState(product.welcomeEmailTemplate ?? '');
  const [stockEnabled, setStockEnabled] = useState(!!product.stockEnabled);
  const [stockQty, setStockQty] = useState(product.stockQty ?? 0);
  const [crossSell, setCrossSell] = useState(!!product.crossSell);
  const [freePlan, setFreePlan] = useState(!!product.freePlan);
  const [busy, setBusy] = useState(false);

  // Détection de modifications non enregistrées (remontée au ProductEditor).
  const dirty =
    (slug.trim() || null) !== (product.slug || null) ||
    (slogan.trim() || null) !== (product.slogan || null) ||
    (shortDesc.trim() || null) !== (product.shortDescription || null) ||
    (description.trim() || null) !== (product.description || null) ||
    (color.trim() || null) !== (product.color || null) ||
    hidden !== !!product.hidden ||
    displayOrder !== (product.displayOrder ?? 0) ||
    (price.trim() || '0') !== dollars(product.priceHtCents) ||
    (promo.trim() || '0') !== dollars(product.promoPriceHtCents) ||
    cycle !== (product.billingCycle ?? 'MONTHLY') ||
    domainRequired !== !!product.domainRequired ||
    (welcomeTemplate.trim() || null) !== (product.welcomeEmailTemplate || null) ||
    stockEnabled !== !!product.stockEnabled ||
    stockQty !== (product.stockQty ?? 0) ||
    crossSell !== !!product.crossSell ||
    freePlan !== !!product.freePlan;
  useEffect(() => {
    onDirtyChange?.('vitrine', dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  async function save() {
    setBusy(true);
    const patch: ProductPatchInput = {
      slug: slug.trim() || null,
      slogan: slogan.trim() || null,
      shortDescription: shortDesc.trim() || null,
      description: description.trim() || null,
      color: color.trim() || null,
      hidden,
      displayOrder: Number.isFinite(displayOrder) ? displayOrder : 0,
      priceHtCents: toCents(price),
      promoPriceHtCents: toCents(promo),
      billingCycle: cycle,
      domainRequired,
      welcomeEmailTemplate: welcomeTemplate.trim() || null,
      stockEnabled,
      stockQty: stockEnabled ? stockQty : null,
      crossSell,
      freePlan,
    };
    const r = await updateProduct(token, product.id, patch);
    setBusy(false);
    if (!r.ok) return toast.error(apiError(r, 'Échec de l’enregistrement de la vitrine.'));
    toast.ok('Vitrine du produit enregistrée.');
    onUpdated?.();
  }

  return (
    <Panel
      title="Vitrine"
      sub="Champs publics de la fiche affichée sur /shop et au checkout."
      className="mb"
    >
      <form
        className="grid-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Slug (URL publique)" hint="/shop/[slug]">
          <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="hebergement-web-starter" />
        </Field>
        <Field label="Slogan" hint="Cross-sell panier">
          <Input value={slogan} onChange={(e) => setSlogan(e.target.value)} placeholder="Le plus vendu" />
        </Field>
        <Field label="Description courte" hint="≤ 50 mots, cross-sell">
          <Input value={shortDesc} onChange={(e) => setShortDesc(e.target.value)} placeholder="Idéal pour lancer votre site…" />
        </Field>
        <Field label="Couleur d'accent">
          <Input value={color} onChange={(e) => setColor(e.target.value)} placeholder="#6c8cff" />
        </Field>
        <Field label="Ordre d'affichage vitrine">
          <Input
            type="number"
            value={displayOrder}
            onChange={(e) => setDisplayOrder(Number(e.target.value) || 0)}
          />
        </Field>
        <Field label="Cycle de facturation">
          <Select value={cycle} onChange={(e) => setCycle(e.target.value)}>
            {BILLING_CYCLES.map((c) => (
              <option key={c} value={c}>{CYCLE_LABEL[c]}</option>
            ))}
          </Select>
        </Field>
        <Field label="Prix HT ($)">
          <Input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="19.00" inputMode="decimal" />
        </Field>
        <Field label="Prix promo HT ($)" hint="Affiché barré">
          <Input value={promo} onChange={(e) => setPromo(e.target.value)} placeholder="12.00" inputMode="decimal" />
        </Field>
        <Field label="Template d'email de bienvenue">
          <Input value={welcomeTemplate} onChange={(e) => setWelcomeTemplate(e.target.value)} placeholder="welcome-vps" />
        </Field>
        <Field label="Quantité de stock" hint="Si stock limité">
          <Input
            type="number"
            value={stockQty}
            onChange={(e) => setStockQty(Number(e.target.value) || 0)}
            disabled={!stockEnabled}
          />
        </Field>
        <div className="grid-form-actions">
          <Button type="submit" disabled={busy}>
            {busy ? 'Enregistrement…' : 'Enregistrer la vitrine'}
          </Button>
          {dirty && <span className="muted" style={{ fontSize: 12 }}>⚠ modifications non enregistrées</span>}
        </div>
      </form>

      <div className="section-title" style={{ marginTop: 22 }}>
        <h3>Options d'affichage & commande</h3>
        <span className="muted" style={{ fontSize: 12 }}>Basculez les comportements de la fiche vitrine.</span>
      </div>
      <div className="stack" style={{ gap: 10 }}>
        {[
          { label: 'Masquer le produit (prime sur le statut)', checked: hidden, set: setHidden },
          { label: 'Exiger un domaine au checkout', checked: domainRequired, set: setDomainRequired },
          { label: 'Stock limité', checked: stockEnabled, set: setStockEnabled },
          { label: 'Éligible aux ventes croisées', checked: crossSell, set: setCrossSell },
          { label: 'Plan Gratuit — inscription directe (sans checkout)', checked: freePlan, set: setFreePlan },
        ].map((t) => (
          <label key={t.label} className="check-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={t.checked} onChange={(e) => t.set(e.target.checked)} />
            <span>{t.label}</span>
          </label>
        ))}
      </div>

      <div className="grid-form-actions" style={{ marginTop: 14 }}>
        <Button onClick={save} disabled={busy}>
          {busy ? 'Enregistrement…' : 'Enregistrer la vitrine'}
        </Button>
      </div>
    </Panel>
  );
}

export default ProductVitrineTab;