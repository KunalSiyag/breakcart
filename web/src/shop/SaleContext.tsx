import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { ApiError, isAbortError, toApiError } from '../api/http';
import { shopApi } from '../api/shop';
import type { Sale } from '../api/types';
import { usePolling } from '../lib/hooks';

/**
 * Polls GET /api/sale every 5s and estimates the offset between the server clock
 * (`sale.now`) and the browser clock, so the countdown is driven by server time
 * even when the customer's machine clock is wrong.
 */

interface SaleState {
  /** null while loading, on error, or when no sale is configured (`/api/sale` → null). */
  sale: Sale | null;
  /** serverTime ≈ Date.now() + offsetMs */
  offsetMs: number;
  error: ApiError | null;
  lastOkAt: number | null;
}

const SaleContext = createContext<SaleState>({ sale: null, offsetMs: 0, error: null, lastOkAt: null });

interface ClockSample {
  offset: number;
  rtt: number;
  at: number;
}

export function SaleProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SaleState>({ sale: null, offsetMs: 0, error: null, lastOkAt: null });
  const samples = useRef<ClockSample[]>([]);

  usePolling(async (signal) => {
    const t0 = Date.now();
    try {
      const { data } = await shopApi.sale(signal);
      const t1 = Date.now();
      if (!data || typeof data !== 'object' || typeof data.startsAt !== 'string') {
        setState({ sale: null, offsetMs: 0, error: null, lastOkAt: t1 });
        return;
      }
      const serverNow = Date.parse(data.now);
      if (Number.isFinite(serverNow)) {
        // NTP-style estimate; trust the lowest-RTT sample of the recent ones, so a slow
        // response during a load spike doesn't make the countdown jump around.
        const rtt = t1 - t0;
        const recent = [...samples.current, { offset: serverNow - (t0 + t1) / 2, rtt, at: t1 }]
          .filter((s) => t1 - s.at < 60_000)
          .slice(-8);
        samples.current = recent;
      }
      const best = samples.current.reduce<ClockSample | null>((b, s) => (!b || s.rtt < b.rtt ? s : b), null);
      setState({ sale: data, offsetMs: best?.offset ?? 0, error: null, lastOkAt: t1 });
    } catch (e) {
      if (!isAbortError(e)) setState((s) => ({ ...s, error: toApiError(e) }));
      throw e;
    }
  }, 5000);

  return <SaleContext.Provider value={state}>{children}</SaleContext.Provider>;
}

export function useSale(): SaleState {
  return useContext(SaleContext);
}

export type SalePhase = 'unknown' | 'upcoming' | 'live' | 'ended';

export interface SaleClock {
  phase: SalePhase;
  /** Seconds until the next boundary (start when upcoming, end when live). */
  remainingSec: number;
}

export function saleClock(sale: Sale | null, offsetMs: number, nowMs: number): SaleClock {
  if (!sale) return { phase: 'unknown', remainingSec: 0 };
  const serverNow = nowMs + offsetMs;
  const start = Date.parse(sale.startsAt);
  const end = Date.parse(sale.endsAt);
  if (Number.isFinite(start) && serverNow < start) {
    return { phase: 'upcoming', remainingSec: (start - serverNow) / 1000 };
  }
  if (Number.isFinite(end) && serverNow >= end) return { phase: 'ended', remainingSec: 0 };
  if (Number.isFinite(end)) return { phase: 'live', remainingSec: (end - serverNow) / 1000 };
  return { phase: sale.live ? 'live' : 'unknown', remainingSec: 0 };
}
