import { lookup } from 'node:dns/promises';
import Redis from 'ioredis';
import { BalancedPool } from 'undici';
import { config } from '../shared/config';
import { KEYS } from '../shared/defs';
import { emitEvent } from '../shared/events';
import { m } from '../shared/metrics';
import { DEFAULT_BEHAVIOUR, rateAt, scenarioById, scenarioDuration, type Behaviour, type Scenario } from '../shared/scenarios';
import { runService } from '../shared/server';
import { clamp, HttpError } from '../shared/util';
import { Api } from './client';
import { journeySampleProbability, JourneyRecorder } from './journey';
import { StepStats } from './stats';
import { bot, shopper, type Persona, type SessionResult, type VuContext } from './vu';

/**
 * Open-model load generator: sessions ARRIVE at the scenario's rate regardless of how
 * the system is coping (real customers don't wait for your servers before showing up).
 * A closed model ("N users in a loop") would politely slow down as you degrade and hide
 * the very overload you are trying to see.
 */
const MAX_ACTIVE_SESSIONS = Number(process.env.LOADGEN_MAX_SESSIONS ?? 25_000);

/**
 * Client-side load balancing across every gateway replica (like an L4 load balancer in
 * front of the edge). Re-resolves DNS every 5s so `docker compose up --scale gateway=N`
 * takes effect live.
 */
const pool = new BalancedPool([], { connections: 1024, pipelining: 1, keepAliveTimeout: 30_000, connectTimeout: 5000 });
async function refreshGatewayUpstreams() {
  const base = new URL(config.urls.gateway);
  try {
    const addrs = await lookup(base.hostname, { all: true, family: 4 });
    const want = new Set(addrs.map((a) => `${base.protocol}//${a.address}:${base.port}`));
    for (const u of pool.upstreams) if (!want.has(u)) pool.removeUpstream(u);
    for (const u of want) if (!pool.upstreams.includes(u)) pool.addUpstream(u);
  } catch {
    if (!pool.upstreams.length) pool.addUpstream(base.origin);
  }
}
void refreshGatewayUpstreams();
setInterval(() => void refreshGatewayUpstreams(), 5000).unref();
const stats = new StepStats();
const pub = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });

type Counters = Record<SessionResult, number> & { started: number };
const zero = (): Counters => ({ started: 0, converted: 0, abandoned: 0, failed: 0, blocked: 0, sold_out: 0 });

class Engine {
  private epoch = 0;
  running = false;
  scenario: Scenario | null = null;
  behaviour: Behaviour = DEFAULT_BEHAVIOUR;
  multiplier = 1;
  private startedAt = 0;
  private lastTick = 0;
  private carry = 0;
  private ticker?: NodeJS.Timeout;
  private publisher?: NodeJS.Timeout;
  private phase: string | null = null;
  private target = 0;
  active = 0;
  dropped = 0;
  private arrivalsThisSec = 0;
  private arrivalRate = 0;
  counters = zero();
  byPersona: Record<Persona, Counters> = { shopper: zero(), bot: zero() };
  anomalies: Record<string, number> = {};
  private tokens: string[] = [];
  private sleepers = new Set<() => void>();

  /** setTimeout that the engine can cut short on stop. */
  private nap(ms: number, epoch: number): Promise<void> {
    if (this.epoch !== epoch) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(t);
        this.sleepers.delete(wake);
        resolve();
      };
      const t = setTimeout(wake, ms);
      this.sleepers.add(wake);
    });
  }

  start(id: string, multiplier: number, behaviour: Partial<Behaviour> = {}) {
    const sc = scenarioById(id);
    if (!sc) throw new HttpError(404, 'NOT_FOUND', `unknown scenario ${id}`);
    this.stop();
    this.epoch++;
    this.running = true;
    this.scenario = sc;
    this.behaviour = { ...DEFAULT_BEHAVIOUR, ...sc.behaviour, ...behaviour };
    this.multiplier = clamp(multiplier, 0.05, 10);
    this.startedAt = Date.now();
    this.lastTick = this.startedAt;
    this.carry = 0;
    this.dropped = 0;
    this.counters = zero();
    this.byPersona = { shopper: zero(), bot: zero() };
    this.anomalies = {};
    this.tokens = [];
    stats.clear();
    this.ticker = setInterval(() => this.tick(), 50);
    this.publisher = setInterval(() => this.publish(), 1000);
    this.publish();
  }

  /** Returns whether a scenario was running. */
  stop(): boolean {
    const was = this.running;
    this.epoch++;
    this.running = false;
    for (const wake of [...this.sleepers]) wake();
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    this.target = 0;
    this.phase = null;
    m.lgTarget.set(0);
    // Keep publishing while sessions drain, then once more.
    if (was) setTimeout(() => this.publish(), 1000);
    if (!was && this.publisher) {
      clearInterval(this.publisher);
      this.publisher = undefined;
    }
    return was;
  }

  private tick() {
    if (!this.running || !this.scenario) return;
    const now = Date.now();
    const t = (now - this.startedAt) / 1000;
    if (t >= scenarioDuration(this.scenario)) {
      emitEvent('info', 'scenario-complete', `Scenario finished: ${this.scenario.name}`, undefined, { throttleMs: 0 });
      this.stop();
      return;
    }
    const { rate, phase } = rateAt(this.scenario, t);
    if (phase !== this.phase && this.phase !== null) {
      emitEvent('info', 'scenario-phase', `Phase: ${phase} (${Math.round(rate * this.multiplier)} sessions/s)`, undefined, { throttleMs: 0 });
    }
    this.phase = phase;
    this.target = rate * this.multiplier;
    m.lgTarget.set(this.target);
    const due = this.target * ((now - this.lastTick) / 1000) + this.carry;
    this.lastTick = now;
    const n = Math.floor(due);
    this.carry = due - n;
    for (let i = 0; i < n; i++) this.spawn();
  }

  private spawn() {
    if (this.active >= MAX_ACTIVE_SESSIONS) {
      this.dropped++;
      m.lgDropped.inc();
      return;
    }
    const persona: Persona = Math.random() < (this.scenario?.botShare ?? 0) ? 'bot' : 'shopper';
    const epoch = this.epoch;
    // A few sessions per second record their whole journey for the war room.
    const journey = Math.random() < journeySampleProbability(this.target) ? new JourneyRecorder(persona) : null;
    const ctx: VuContext = {
      api: new Api(pool, stats, () => this.epoch === epoch, journey),
      b: this.behaviour,
      ip: persona === 'bot' ? `45.67.${Math.floor(Math.random() * 4)}.${Math.floor(Math.random() * 16)}` : randomIp(),
      alive: () => this.epoch === epoch,
      anomaly: (kind) => {
        this.anomalies[kind] = (this.anomalies[kind] ?? 0) + 1;
        m.lgAnomalies.inc({ kind });
      },
      takeToken: () => this.tokens.pop(),
      returnToken: (t) => {
        if (this.tokens.length < 5000) this.tokens.push(t);
      },
      sleep: (ms) => this.nap(ms, epoch),
    };
    this.active++;
    this.arrivalsThisSec++;
    this.counters.started++;
    this.byPersona[persona].started++;
    m.lgArrivals.inc({ persona });
    m.lgActive.set(this.active);
    const run = persona === 'bot' ? bot(ctx) : shopper(ctx);
    void run
      .then((result) => {
        if (this.epoch === epoch || result !== 'abandoned') {
          this.counters[result]++;
          this.byPersona[persona][result]++;
        }
        m.lgSessions.inc({ persona, result });
        // Stragglers of a stopped run are dropped, like their stats.
        if (journey && this.epoch === epoch) pub.publish(KEYS.journeysChannel, JSON.stringify(journey.finish(result))).catch(() => undefined);
      })
      .finally(() => {
        this.active--;
        m.lgActive.set(this.active);
      });
  }

  status() {
    const sc = this.scenario;
    // Once a run is over and its sessions have drained, report no step rates (the last 5s window
    // would otherwise keep showing the final moments of the run as if they were live).
    const steps = this.running || this.active > 0 ? stats.snapshot(5) : [];
    return {
      running: this.running,
      scenarioId: sc?.id ?? null,
      scenarioName: sc?.name ?? null,
      elapsedSec: this.running ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      durationSec: sc ? scenarioDuration(sc) : 0,
      phase: this.phase,
      multiplier: this.multiplier,
      targetArrivalPerSec: Math.round(this.target * 10) / 10,
      actualArrivalPerSec: this.arrivalRate,
      activeSessions: this.active,
      droppedArrivals: this.dropped,
      rps: Math.round(steps.reduce((s, x) => s + x.rps, 0) * 10) / 10,
      steps,
      sessions: {
        started: this.counters.started,
        converted: this.counters.converted,
        abandoned: this.counters.abandoned,
        failed: this.counters.failed,
        blocked: this.counters.blocked,
        soldOut: this.counters.sold_out,
      },
      byPersona: this.byPersona,
      anomalies: this.anomalies,
    };
  }

  private publish() {
    this.arrivalRate = this.arrivalsThisSec;
    this.arrivalsThisSec = 0;
    pub.publish(KEYS.loadgenStatsChannel, JSON.stringify(this.status())).catch(() => undefined);
    if (!this.running && this.active === 0 && this.publisher) {
      clearInterval(this.publisher);
      this.publisher = undefined;
    }
  }
}

function randomIp() {
  // A large pool of residential/mobile addresses (some shared, as with carrier NAT).
  return `10.${Math.floor(Math.random() * 64)}.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;
}

const engine = new Engine();

void runService({
  name: 'loadgen',
  noChaos: true,
  routes: async (app) => {
    app.get('/status', async () => engine.status());
    app.post<{ Body: { scenarioId: string; multiplier?: number; behaviour?: Partial<Behaviour> } }>('/start', async (req) => {
      engine.start(String(req.body?.scenarioId ?? ''), Number(req.body?.multiplier ?? 1) || 1, req.body?.behaviour ?? {});
      return engine.status();
    });
    app.post('/stop', async () => ({ wasRunning: engine.stop(), ...engine.status() }));
    app.patch<{ Body: { multiplier: number } }>('/multiplier', async (req) => {
      const v = Number(req.body?.multiplier);
      if (!Number.isFinite(v) || v <= 0) throw new HttpError(400, 'BAD_REQUEST', 'multiplier must be > 0');
      engine.multiplier = clamp(v, 0.05, 10);
      emitEvent('info', 'loadgen-multiplier', `Traffic multiplier set to x${engine.multiplier}`, undefined, { throttleMs: 0 });
      return engine.status();
    });
  },
  shutdown: async () => {
    engine.stop();
    await pool.close();
    pub.disconnect();
  },
});
