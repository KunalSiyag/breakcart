import { useSyncExternalStore } from 'react';

/**
 * Request log for the storefront's "Request inspector" drawer: what the customer's
 * browser actually experienced, call by call. Entries are immutable; every change
 * swaps the array so useSyncExternalStore subscribers re-render.
 */

export interface InspectorEntry {
  id: number;
  startedAt: number;
  method: string;
  path: string;
  /** null while in flight; 0 when no HTTP response arrived (network error / timeout). */
  status: number | null;
  ms: number | null;
  code: string | null;
  message: string | null;
  /** Background polling (sale clock) — hidden by default in the drawer. */
  background: boolean;
  /** Interesting request headers / context: idempotency key, queue pass, re-auth. */
  notes: string[];
}

const MAX_ENTRIES = 150;

let entries: readonly InspectorEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export const inspector = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): readonly InspectorEntry[] {
    return entries;
  },
  start(init: { method: string; path: string; background: boolean; notes: string[] }): number {
    const id = nextId++;
    const entry: InspectorEntry = {
      id,
      startedAt: Date.now(),
      status: null,
      ms: null,
      code: null,
      message: null,
      ...init,
    };
    entries = [entry, ...entries].slice(0, MAX_ENTRIES);
    emit();
    return id;
  },
  finish(id: number, patch: Pick<InspectorEntry, 'status' | 'ms'> & Partial<Pick<InspectorEntry, 'code' | 'message'>>) {
    let changed = false;
    entries = entries.map((e) => {
      if (e.id !== id) return e;
      changed = true;
      return { ...e, code: null, message: null, ...patch };
    });
    if (changed) emit();
  },
  clear() {
    entries = [];
    emit();
  },
};

export function useInspectorEntries(): readonly InspectorEntry[] {
  return useSyncExternalStore(inspector.subscribe, inspector.getSnapshot, inspector.getSnapshot);
}
