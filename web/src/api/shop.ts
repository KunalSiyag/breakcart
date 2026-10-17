import { local } from '../lib/storage';
import { shortId } from '../lib/ids';
import { ApiError, errorFromResponse, isApiError, rawRequest, type RequestOptions } from './http';
import { inspector } from './inspector';
import type {
  Cart,
  CategoriesResponse,
  GuestAuthResponse,
  HomeResponse,
  OrderResponse,
  OrdersResponse,
  PaymentMethod,
  ProductDetail,
  ProductsPage,
  QueueJoinResponse,
  QueueStatusResponse,
  Sale,
  SearchResponse,
} from './types';

/**
 * The storefront's single fetch wrapper:
 *  - attaches `Authorization: Bearer <guest token>` (POST /api/auth/guest on first use),
 *  - on 401 re-authenticates once and replays the request,
 *  - records method / path / status / latency / error code in the request inspector,
 *  - turns every failure into an ApiError carrying the contract's error code.
 */

const AUTH_KEY = 'breakcart.auth.v1';
const DEFAULT_TIMEOUT_MS = 65_000;

interface StoredAuth {
  token: string;
  userId: string | number;
  issuedAt: number;
}

let auth: StoredAuth | null = readStoredAuth();
let authInFlight: Promise<StoredAuth> | null = null;

function readStoredAuth(): StoredAuth | null {
  const v = local.getJSON<StoredAuth>(AUTH_KEY);
  return v && typeof v.token === 'string' && v.token ? v : null;
}

export interface ApiOptions extends RequestOptions {
  /** Defaults to true; the guest-auth call itself opts out. */
  auth?: boolean;
  /** Mark background polling so the inspector can hide it. */
  background?: boolean;
}

export interface ApiResult<T> {
  status: number;
  data: T;
  ms: number;
}

function inspectorNotes(opts: ApiOptions, extra: string[]): string[] {
  const notes = [...extra];
  const h = opts.headers ?? {};
  const idem = h['Idempotency-Key'];
  if (idem) notes.push(`Idempotency-Key ${shortId(idem)}…`);
  if (h['X-Queue-Pass']) notes.push('X-Queue-Pass attached');
  return notes;
}

async function send<T>(path: string, opts: ApiOptions, token: string | null, extraNotes: string[] = []): Promise<ApiResult<T>> {
  const method = (opts.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { ...opts.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  const id = inspector.start({
    method,
    path,
    background: Boolean(opts.background),
    notes: inspectorNotes(opts, extraNotes),
  });
  const t0 = performance.now();
  try {
    const { res, body } = await rawRequest(path, {
      ...opts,
      method,
      headers,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) {
      const err = errorFromResponse(res, body);
      inspector.finish(id, { status: res.status, ms, code: err.code, message: err.message });
      throw err;
    }
    inspector.finish(id, { status: res.status, ms });
    return { status: res.status, data: body as T, ms };
  } catch (e) {
    if (isApiError(e) && e.status === 0) {
      const ms = Math.round(performance.now() - t0);
      inspector.finish(id, { status: 0, ms, code: e.code, message: e.message });
    }
    throw e;
  }
}

async function obtainToken(): Promise<StoredAuth> {
  if (!authInFlight) {
    authInFlight = (async () => {
      const r = await send<GuestAuthResponse>('/api/auth/guest', { method: 'POST', body: {} }, null);
      if (!r.data || typeof r.data.token !== 'string') {
        throw new ApiError({
          status: r.status,
          code: 'BAD_RESPONSE',
          message: 'Guest login returned no token',
          retryable: true,
        });
      }
      auth = { token: r.data.token, userId: r.data.userId, issuedAt: Date.now() };
      local.setJSON(AUTH_KEY, auth);
      return auth;
    })().finally(() => {
      authInFlight = null;
    });
  }
  return authInFlight;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<ApiResult<T>> {
  const needsAuth = opts.auth !== false;
  const token = needsAuth ? (auth?.token ?? (await obtainToken()).token) : null;
  try {
    return await send<T>(path, opts, token);
  } catch (e) {
    if (!needsAuth || !isApiError(e) || e.status !== 401) throw e;
    // Token unknown to the server (expired, Redis flushed, data reset): re-auth once and replay.
    let fresh: string;
    if (auth && auth.token !== token) {
      fresh = auth.token; // another request already re-authenticated
    } else {
      auth = null;
      local.remove(AUTH_KEY);
      fresh = (await obtainToken()).token;
    }
    return send<T>(path, opts, fresh, ['replayed after 401 → new guest session']);
  }
}

export function currentUserId(): string | number | null {
  return auth?.userId ?? null;
}

const qs = (params: Record<string, string | number | undefined | null>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
};

export const shopApi = {
  home: (signal?: AbortSignal) => api<HomeResponse>('/api/home', { signal }),
  products: (params: { category?: string; page?: number; pageSize?: number }, signal?: AbortSignal) =>
    api<ProductsPage>(`/api/products${qs(params)}`, { signal }),
  product: (id: string | number, signal?: AbortSignal) =>
    api<ProductDetail>(`/api/products/${encodeURIComponent(String(id))}`, { signal }),
  categories: (signal?: AbortSignal) => api<CategoriesResponse>('/api/categories', { signal }),
  search: (q: string, signal?: AbortSignal) => api<SearchResponse>(`/api/search${qs({ q })}`, { signal }),
  sale: (signal?: AbortSignal) => api<Sale>('/api/sale', { signal, background: true, timeoutMs: 15_000 }),

  cart: (signal?: AbortSignal) => api<Cart>('/api/cart', { signal }),
  addToCart: (productId: number, qty: number) =>
    api<Cart>('/api/cart/items', { method: 'POST', body: { productId, qty } }),
  removeFromCart: (productId: number) =>
    api<Cart>(`/api/cart/items/${encodeURIComponent(String(productId))}`, { method: 'DELETE' }),
  clearCart: () => api<Cart>('/api/cart', { method: 'DELETE' }),

  checkout: (idempotencyKey: string, couponCode: string | null, queuePass: string | null) =>
    api<OrderResponse>('/api/checkout', {
      method: 'POST',
      headers: {
        'Idempotency-Key': idempotencyKey,
        ...(queuePass ? { 'X-Queue-Pass': queuePass } : {}),
      },
      body: couponCode ? { couponCode } : {},
    }),
  pay: (orderId: string, idempotencyKey: string, method: PaymentMethod) =>
    api<OrderResponse>(`/api/orders/${encodeURIComponent(orderId)}/pay`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: { method },
    }),
  orders: (signal?: AbortSignal) => api<OrdersResponse>('/api/orders', { signal }),
  order: (id: string, signal?: AbortSignal) =>
    api<OrderResponse>(`/api/orders/${encodeURIComponent(id)}`, { signal }),

  queueJoin: () => api<QueueJoinResponse>('/api/queue/join', { method: 'POST', body: {} }),
  queueStatus: (ticket: number, signal?: AbortSignal) =>
    api<QueueStatusResponse>(`/api/queue/status${qs({ ticket })}`, { signal }),
};
