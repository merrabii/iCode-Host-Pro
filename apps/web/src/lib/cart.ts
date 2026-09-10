'use client';

/**
 * Panier — 100 % navigateur (localStorage), aucune persistance serveur avant
 * paiement validé (§10, choix owner : « si paiement annulé, aucune donnée
 * serveur, tout reste dans le navigateur »).
 */
const KEY = 'codiali.cart.v1';

/** Une ligne de config retenue pour le produit choisi. */
export interface CartItem {
  product: {
    id: string;
    name: string;
    slug?: string | null;
    priceHtCents?: number | null;
    promoPriceHtCents?: number | null;
    billingCycle?: string;
    color?: string | null;
    // Contrôles du récap /cart (rattachés au produit choisi).
    allowEditConfig?: boolean;
    installationFeeCents?: number;
    taxRatePercent?: number;
    checkoutFields?: {
      id: string;
      key: string;
      label: string;
      type: string;
      placeholder?: string | null;
      required: boolean;
    }[];
  };
  // options : optionId → choice { id, label, priceDeltaHtCents }
  options: Record<string, { id: string; label: string; priceDeltaHtCents: number }>;
  // addons cochés : addonId → { id, name, priceHtCents }
  addons: Record<string, { id: string; name: string; priceHtCents: number }>;
}

export function emptyCart(): CartItem | null {
  return null;
}

function safeRead(): CartItem | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CartItem;
    if (!parsed?.product?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

function safeWrite(item: CartItem | null): void {
  try {
    if (item) window.localStorage.setItem(KEY, JSON.stringify(item));
    else window.localStorage.removeItem(KEY);
  } catch {
    /* localStorage indisponible (privé/refusé) — le panier reste en mémoire */
  }
}

export const cartStorage = {
  read: safeRead,
  write: safeWrite,
  clear: () => safeWrite(null),
};

/** Prix HT total du panier : produit + options + suppléments (le taux de taxe
 *  est recalculé côté serveur au paiement — pas besoin ici). */
export function cartHtCents(item: CartItem | null): number {
  if (!item) return 0;
  const base = item.product.priceHtCents ?? 0;
  const opts = Object.values(item.options ?? {}).reduce((a, o) => a + o.priceDeltaHtCents, 0);
  const addons = Object.values(item.addons ?? {}).reduce((a, ad) => a + ad.priceHtCents, 0);
  return base + opts + addons;
}

/** Coordonnées du client saisies à l'étape /cart — stockées navigateur uniquement,
 *  jamais envoyées au serveur avant un paiement validé (§10). */
export interface BuyerContact {
  name: string;
  email: string;
  phone: string;
  paymentMethodId?: string;
}

const CONTACT_KEY = 'codiali.contact.v1';

export const buyerStorage = {
  read(): BuyerContact | null {
    try {
      const raw = window.localStorage.getItem(CONTACT_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw) as BuyerContact;
      if (!p?.email) return null;
      return p;
    } catch {
      return null;
    }
  },
  write(c: BuyerContact): void {
    try {
      window.localStorage.setItem(CONTACT_KEY, JSON.stringify(c));
    } catch {
      /* localStorage indisponible — reste en mémoire */
    }
  },
  clear(): void {
    try {
      window.localStorage.removeItem(CONTACT_KEY);
    } catch {
      /* noop */
    }
  },
};