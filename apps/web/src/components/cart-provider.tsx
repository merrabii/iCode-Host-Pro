'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { cartStorage, cartHtCents, type CartItem } from '@/lib/cart';

interface CartCtx {
  item: CartItem | null;
  count: number; // nbr d'éléments configurés (options + add-ons) — le badge du panier
  htCents: number;
  setItem: (item: CartItem) => void;
  clear: () => void;
}

const Ctx = createContext<CartCtx | null>(null);

/** Panier client persisté dans le navigateur (localStorage). Fourni par
 *  StoreShell — pages /shop et /checkout lisent `useCart()`. */
export function CartProvider({ children }: { children: ReactNode }) {
  const [item, setItemState] = useState<CartItem | null>(null);

  useEffect(() => {
    setItemState(cartStorage.read());
  }, []);

  const setItem = useCallback((next: CartItem) => {
    setItemState(next);
    cartStorage.write(next);
  }, []);

  const clear = useCallback(() => {
    setItemState(null);
    cartStorage.clear();
  }, []);

  const value = useMemo<CartCtx>(() => {
    const count = item
      ? Object.keys(item.options ?? {}).length + Object.keys(item.addons ?? {}).length
      : 0;
    return {
      item,
      count,
      htCents: cartHtCents(item),
      setItem,
      clear,
    };
  }, [item, setItem, clear]);

  // Le contenu est rendu immédiatement (SSR) ; le panier s'hydrate après la
  // lecture du localStorage — pas de flash de page ni de "panier vide" bloquant.
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCart(): CartCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useCart doit être utilisé sous <CartProvider>.');
  return ctx;
}