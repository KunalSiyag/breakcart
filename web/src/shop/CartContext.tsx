import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, isAbortError, toApiError } from '../api/http';
import { shopApi } from '../api/shop';
import type { Cart, CartLine } from '../api/types';

interface CartContextValue {
  cart: Cart | null;
  /** Total units in the cart (badge). */
  count: number;
  loading: boolean;
  error: ApiError | null;
  refresh: () => Promise<void>;
  add: (productId: number, qty: number) => Promise<Cart>;
  remove: (productId: number) => Promise<Cart>;
  /** Set a line to an absolute quantity (see note below). */
  setQty: (line: CartLine, qty: number) => Promise<Cart>;
  clear: () => Promise<Cart>;
  /** Replace local cart state with a server response we already have. */
  replace: (cart: Cart) => void;
}

const CartContext = createContext<CartContextValue | null>(null);

function normalise(cart: Cart | null | undefined): Cart {
  return {
    items: Array.isArray(cart?.items) ? cart.items : [],
    subtotalCents: typeof cart?.subtotalCents === 'number' ? cart.subtotalCents : 0,
  };
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [cart, setCart] = useState<Cart | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const mounted = useRef(true);

  const apply = useCallback((c: Cart) => {
    const n = normalise(c);
    if (mounted.current) {
      setCart(n);
      setError(null);
    }
    return n;
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await shopApi.cart();
      apply(data);
    } catch (e) {
      if (!isAbortError(e) && mounted.current) setError(toApiError(e));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const add = useCallback(
    async (productId: number, qty: number) => apply((await shopApi.addToCart(productId, qty)).data),
    [apply],
  );
  const remove = useCallback(
    async (productId: number) => apply((await shopApi.removeFromCart(productId)).data),
    [apply],
  );
  const clear = useCallback(async () => apply((await shopApi.clearCart()).data), [apply]);

  // POST /api/cart/items adds `qty` to the line (the cart service HINCRBYs); there is no
  // "set quantity" endpoint. Increases add the difference; decreases remove the line and
  // add it back with the new quantity.
  const setQty = useCallback(
    async (line: CartLine, qty: number) => {
      if (qty <= 0) return remove(line.productId);
      if (qty > line.qty) return apply((await shopApi.addToCart(line.productId, qty - line.qty)).data);
      if (qty === line.qty) return apply({ items: cart?.items ?? [], subtotalCents: cart?.subtotalCents ?? 0 });
      await shopApi.removeFromCart(line.productId);
      return apply((await shopApi.addToCart(line.productId, qty)).data);
    },
    [apply, remove, cart],
  );

  const value = useMemo<CartContextValue>(() => {
    const count = cart ? cart.items.reduce((n, l) => n + (Number.isFinite(l.qty) ? l.qty : 0), 0) : 0;
    return { cart, count, loading, error, refresh, add, remove, setQty, clear, replace: (c) => void apply(c) };
  }, [cart, loading, error, refresh, add, remove, setQty, clear, apply]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used inside <CartProvider>');
  return ctx;
}
