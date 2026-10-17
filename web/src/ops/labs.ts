import { useEffect, useRef } from 'react';
import { controlApi } from '../api/control';
import type { Lab, LabDifficulty } from '../api/types';
import { useAsync } from '../lib/hooks';
import { normalizeLab } from './normalize';
import { useOps } from './store';

let cache: Lab[] | null = null;

/** GET /control/labs, cached for the session (lab definitions are static). */
export function useLabs() {
  const result = useAsync(async (signal) => {
    if (cache) return cache;
    const raw = await controlApi.labs(signal);
    const labs = raw.map(normalizeLab).filter((l): l is Lab => l !== null);
    if (labs.length) cache = labs;
    return labs;
  }, []);

  // If the first load failed because the control plane was down, retry once it is back
  // (only on the down → up transition, so a persistent error can't loop).
  const reachable = useOps((s) => s.reachable);
  const prev = useRef(reachable);
  const { error, data, reload } = result;
  useEffect(() => {
    if (reachable === true && prev.current === false && error && !data) reload();
    prev.current = reachable;
  }, [reachable, error, data, reload]);

  return result;
}

export const DIFFICULTY_META: Record<LabDifficulty, { label: string; rank: number; icon: string }> = {
  beginner: { label: 'Beginner', rank: 0, icon: '●○○' },
  intermediate: { label: 'Intermediate', rank: 1, icon: '●●○' },
  advanced: { label: 'Advanced', rank: 2, icon: '●●●' },
};
