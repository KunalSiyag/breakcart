import { asArray, errorFromResponse, rawRequest, type RequestOptions } from './http';
import type {
  ActionResponse,
  ChaosPatch,
  ControlAction,
  ControlStateResponse,
  Integrity,
  JourneysResponse,
  Lab,
  LabStartResponse,
  LabVariant,
  LoadgenStats,
  PresetId,
  PromQueryRangeResponse,
  RecentEventsResponse,
  RuntimeState,
  ScenarioSummary,
  ServicesResponse,
  Summary,
} from './types';

/** Control-plane client (`/control/*`). Not recorded in the shop's request inspector. */
async function ctl<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { res, body } = await rawRequest(`/control${path}`, { timeoutMs: 15_000, ...opts });
  if (!res.ok) throw errorFromResponse(res, body);
  return body as T;
}

const enc = encodeURIComponent;

export const controlApi = {
  state: (signal?: AbortSignal) => ctl<ControlStateResponse>('/state', { signal }),
  patchFlags: (patch: Record<string, string>) => ctl<RuntimeState>('/flags', { method: 'PATCH', body: patch }),
  patchChaos: (patch: ChaosPatch) => ctl<RuntimeState>('/chaos', { method: 'PATCH', body: patch }),
  patchTuning: (patch: Record<string, number>) => ctl<RuntimeState>('/tuning', { method: 'PATCH', body: patch }),
  preset: (id: PresetId) => ctl<RuntimeState>(`/presets/${enc(id)}`, { method: 'POST', body: {} }),
  action: (action: ControlAction, body: Record<string, unknown> = {}) =>
    ctl<ActionResponse>(`/actions/${enc(action)}`, { method: 'POST', body, timeoutMs: 60_000 }),

  scenarios: async (signal?: AbortSignal) => asArray<ScenarioSummary>(await ctl<unknown>('/scenarios', { signal })),
  startScenario: (id: string, multiplier?: number) =>
    ctl<Partial<LoadgenStats>>(`/scenarios/${enc(id)}/start`, {
      method: 'POST',
      body: multiplier != null ? { multiplier } : {},
    }),
  stopScenario: () => ctl<Partial<LoadgenStats>>('/scenarios/stop', { method: 'POST', body: {} }),
  patchLoadgen: (multiplier: number) =>
    ctl<Partial<LoadgenStats>>('/loadgen', { method: 'PATCH', body: { multiplier } }),
  loadgen: (signal?: AbortSignal) => ctl<LoadgenStats>('/loadgen', { signal }),

  labs: async (signal?: AbortSignal) => asArray<Lab>(await ctl<unknown>('/labs', { signal })),
  startLab: (id: string, variant: LabVariant, multiplier?: number) =>
    ctl<LabStartResponse>(`/labs/${enc(id)}/start`, {
      method: 'POST',
      body: multiplier != null ? { variant, multiplier } : { variant },
      // Stops the running scenario, drains in-flight shoppers (up to ~20s) and resets data first.
      timeoutMs: 90_000,
    }),

  integrity: (signal?: AbortSignal) => ctl<Integrity>('/integrity', { signal }),
  summary: (signal?: AbortSignal) => ctl<Summary>('/summary', { signal, timeoutMs: 8_000 }),
  services: (signal?: AbortSignal) => ctl<ServicesResponse>('/services', { signal }),
  recentEvents: (signal?: AbortSignal) => ctl<RecentEventsResponse>('/events/recent', { signal }),
  recentJourneys: (signal?: AbortSignal) => ctl<JourneysResponse>('/journeys/recent', { signal }),
  promRange: (query: string, minutes = 10, step = 2, signal?: AbortSignal) =>
    ctl<PromQueryRangeResponse>(
      `/prom/query_range?${new URLSearchParams({ query, minutes: String(minutes), step: String(step) })}`,
      { signal, timeoutMs: 10_000 },
    ),
};
