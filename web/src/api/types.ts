/**
 * Types mirroring docs/contract.md (public API, control-plane API, SSE events) and
 * server/src/shared/defs.ts (runtime knobs).
 *
 * Runtime knobs are served dynamically by GET /control/state, so flag keys, modes,
 * chaos fields and tuning keys are typed loosely (string-keyed records) and the UI
 * renders controls from `defs` rather than from hard-coded lists.
 */

/* ------------------------------------------------------------------ errors */

export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'RATE_LIMITED'
  | 'OVERLOADED'
  | 'QUEUE_REQUIRED'
  | 'BOT_SUSPECTED'
  | 'OUT_OF_STOCK'
  | 'PRICE_CHANGED'
  | 'COUPON_EXHAUSTED'
  | 'PAYMENT_DECLINED'
  | 'PAYMENT_TIMEOUT'
  | 'PAYMENT_PENDING'
  | 'REQUEST_IN_PROGRESS'
  | 'INVALID_STATE'
  | 'NOT_FOUND'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INTERNAL'
  | 'INJECTED_FAULT'
  | 'SALE_NOT_STARTED'
  // Not in the contract's list but emitted by the services today:
  | 'BAD_REQUEST'
  | 'INVALID_COUPON'
  | 'COUPON_NOT_APPLICABLE'
  | 'ORDER_EXPIRED';

/** Codes the browser produces itself (no server response to read). */
export type ClientErrorCode = 'NETWORK_ERROR' | 'TIMEOUT' | 'ABORTED' | 'BAD_RESPONSE';

export interface ApiErrorBody {
  error: { code: ErrorCode | string; message: string; retryable: boolean };
}

/* ------------------------------------------------------------------ public API */

export interface StockInfo {
  available: number;
  total: number;
}

export interface ProductCard {
  id: number;
  sku: string;
  name: string;
  brand: string;
  category: string;
  /** What the customer pays now (deal price if the sale is live). */
  priceCents: number;
  /** Regular price. */
  listPriceCents: number;
  /** Strike-through price. */
  mrpCents: number;
  dealPriceCents: number | null;
  isDeal: boolean;
  dealLive: boolean;
  rating: number;
  reviewCount: number;
  imageSeed: number;
  priceVersion: number;
}

export interface Product extends ProductCard {
  description: string;
  stock: StockInfo | null;
}

export type DealCard = ProductCard & { stock: StockInfo | null };

export interface Sale {
  name: string;
  startsAt: string;
  endsAt: string;
  now: string;
  live: boolean;
}

export interface CartLine {
  productId: number;
  sku: string;
  name: string;
  qty: number;
  unitPriceCents: number;
  priceVersion: number;
  imageSeed: number;
}

export interface Cart {
  items: CartLine[];
  subtotalCents: number;
}

export type OrderStatus =
  | 'CREATED'
  | 'REJECTED'
  | 'AWAITING_PAYMENT'
  | 'PAYMENT_IN_PROGRESS'
  | 'PAYMENT_PENDING'
  | 'PAID'
  | 'PAYMENT_FAILED'
  | 'EXPIRED';

export interface OrderItem {
  productId: number;
  sku: string;
  name: string;
  qty: number;
  unitPriceCents: number;
}

export interface Order {
  id: string;
  status: OrderStatus;
  totalCents: number;
  discountCents: number;
  couponCode: string | null;
  items: OrderItem[];
  createdAt: string;
  updatedAt: string;
  failureReason: string | null;
}

export interface GuestAuthResponse {
  token: string;
  userId: string | number;
}

export interface HomeResponse {
  sale: Sale;
  deals: DealCard[];
  recommendations: ProductCard[];
  degraded: string[];
}

export interface ProductsPage {
  items: ProductCard[];
  page: number;
  pageSize: number;
  total: number;
}

export type ProductDetail = Product & { recommendations: ProductCard[]; degraded: string[] };

export interface Category {
  name: string;
  count: number;
}

export interface CategoriesResponse {
  items: Category[];
}

export interface SearchResponse {
  items: ProductCard[];
  tookMs: number;
}

export interface CheckoutRequest {
  couponCode?: string;
}

export interface OrderResponse {
  order: Order;
}

export interface OrdersResponse {
  items: Order[];
}

export type PaymentMethod = 'card' | 'upi';

export interface QueueJoinResponse {
  ticket: number;
  position: number;
  etaSec: number;
}

export interface QueueStatusResponse {
  admitted: boolean;
  position: number;
  etaSec: number;
  pass?: string;
}

/* ------------------------------------------------------------------ runtime knobs (defs.ts) */

export interface FlagDef {
  description: string;
  modes: string[];
  naive: string;
  hardened: string;
  /** Lab id that teaches this flag. */
  lab: string;
  modeHelp: Record<string, string>;
}

export interface ServiceChaos {
  latencyMs: number;
  latencyJitterMs: number;
  latencyPct: number;
  errorPct: number;
  hangPct: number;
  hangMs: number;
  cpuBurnMs: number;
  leakMbPerMin: number;
  gcPauseMs: number;
  gcPauseEverySec: number;
  clockSkewMs: number;
  dbSlowMs: number;
  dbSlowPct: number;
  redisLatencyMs: number;
  redisDown: boolean;
}

export interface PaymentsChaos {
  medianMs: number;
  p99Ms: number;
  declinePct: number;
  lateResponsePct: number;
  lateResponseMs: number;
  rateLimitPerSec: number;
  outage: boolean;
}

export interface DataChaos {
  replicaLagMs: number;
  eventPublishFailPct: number;
  poisonPct: number;
  consumerPaused: boolean;
  consumerSlowMs: number;
}

export interface Chaos {
  services: Record<string, Partial<ServiceChaos> | undefined>;
  payments: PaymentsChaos;
  data: DataChaos;
}

export interface Tuning {
  dbPoolSize: number;
  dbAcquireTimeoutMs: number;
  dbStatementTimeoutMs: number;
  upstreamTimeoutMs: number;
  upstreamConnections: number;
  paymentTimeoutMs: number;
  gatewayMaxInflight: number;
  rateLimitPerSec: number;
  rateLimitBurst: number;
  waitingRoomAdmitPerSec: number;
  cacheTtlSec: number;
  cacheRebuildCostMs: number;
  reservationTtlSec: number;
  raceWindowMs: number;
}

/** A knob value as rendered by the generic control panels. */
export type KnobValue = number | boolean;
export type KnobRecord = Record<string, KnobValue>;

export interface RuntimeState {
  version: number;
  updatedAt: string;
  /** flagKey → current mode. */
  flags: Record<string, string>;
  chaos: Chaos;
  tuning: Tuning;
}

export interface ControlDefs {
  flags: Record<string, FlagDef>;
  serviceChaosDefaults: ServiceChaos;
  paymentsChaosDefaults: PaymentsChaos;
  dataChaosDefaults: DataChaos;
  tuningDefaults: Tuning;
  tuningHelp: Record<string, string>;
  services: string[];
}

export interface ControlStateResponse {
  runtime: RuntimeState;
  defs: ControlDefs;
}

export interface ChaosPatch {
  services?: Record<string, Partial<Record<string, KnobValue>>>;
  payments?: Partial<Record<string, KnobValue>>;
  data?: Partial<Record<string, KnobValue>>;
}

export type PresetId = 'hardened' | 'naive' | 'calm-chaos';

export type ControlAction =
  | 'flush-cache'
  | 'kill-service'
  | 'reset-data'
  | 'inject-poison'
  | 'price-change'
  | 'restock';

export interface ActionResponse {
  ok: boolean;
  message: string;
}

/* ------------------------------------------------------------------ scenarios / labs / loadgen */

export interface ScenarioPhase {
  name: string;
  durationSec: number;
  fromRate: number;
  toRate: number;
}

export interface ScenarioSummary {
  id: string;
  name: string;
  description: string;
  durationSec: number;
  saleStartsAtSec: number | null;
  botShare: number;
  phases: ScenarioPhase[];
  timeline: { atSec: number; description: string }[];
}

export type LabDifficulty = 'beginner' | 'intermediate' | 'advanced';

export interface Lab {
  id: string;
  title: string;
  category: string;
  difficulty: LabDifficulty;
  summary: string;
  story: string;
  symptoms: string[];
  watch: string[];
  rootCause: string;
  fix: string;
  realWorld: string;
  flags: string[];
  scenario: string;
  steps: string[];
  brokenPatch: object;
  fixedPatch: object;
}

export type LabVariant = 'broken' | 'fixed';

export interface LoadgenStep {
  step: string;
  rps: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  errorPct: number;
  codes: Record<string, number>;
}

export interface LoadgenSessions {
  started: number;
  converted: number;
  abandoned: number;
  failed: number;
  blocked: number;
  soldOut: number;
}

export interface LoadgenStats {
  running: boolean;
  scenarioId: string | null;
  scenarioName: string | null;
  elapsedSec: number;
  durationSec: number;
  phase: string | null;
  multiplier: number;
  targetArrivalPerSec: number;
  actualArrivalPerSec: number;
  activeSessions: number;
  droppedArrivals: number;
  rps: number;
  steps: LoadgenStep[];
  sessions: LoadgenSessions;
  anomalies: Record<string, number>;
}

export interface LabStartResponse {
  ok: boolean;
  runtime: RuntimeState;
  loadgen: LoadgenStats;
}

/* ------------------------------------------------------------------ integrity / summary */

export interface IntegrityViolations {
  oversoldUnits: number;
  negativeStockSkus: number;
  duplicateOrders: number;
  duplicateCharges: number;
  orphanCharges: number;
  couponOverRedemptions: number;
  priceMismatches: number;
  stuckOrders: number;
  lostEvents: number;
  phantomHeldUnits: number;
  /** Paid orders whose stock hold was never committed (the unit can expire and be sold twice). Absent on older control planes. */
  paidUncommitted: number;
}

export interface OversoldSku {
  sku: string;
  name: string;
  total: number;
  claimed: number;
}

export interface IntegrityTotals {
  orders: number;
  paidOrders: number;
  gmvCents: number;
  charges: number;
  shipments: number;
  unitsSold: number;
  dlqDepth: number;
}

export interface Integrity {
  checkedAt: string;
  violations: IntegrityViolations;
  oversoldSkus: OversoldSku[];
  totals: IntegrityTotals;
}

export interface GatewayStats {
  rps: number;
  errorPct: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  inflight: number;
}

export interface RouteStats {
  route: string;
  rps: number;
  p95Ms: number;
  p99Ms: number;
  errorPct: number;
}

export interface DbPoolStats {
  total: number;
  idle: number;
  waiting: number;
  /** Configured pool size (the control plane sends it alongside the contract fields). */
  max?: number;
}

export interface ServiceStats {
  service: string;
  up: boolean;
  rps: number;
  p99Ms: number;
  errorPct: number;
  eventLoopLagMs: number;
  inflight: number;
  dbPool: DbPoolStats | null;
  memMb: number;
  cpuPct: number;
  /** Running replicas. Absent on older control planes. */
  instances?: number;
}

export type BreakerState = 'closed' | 'half_open' | 'open';

export interface BreakerStats {
  service: string;
  target: string;
  state: BreakerState;
}

export interface BusinessStats {
  checkoutsPerMin: number;
  paidPerMin: number;
  gmvPerMinCents: number;
  paymentSuccessPct: number;
  waitingRoomLength: number;
  consumerLag: number;
  dlqDepth: number;
  cacheHitPct: number;
  rateLimitedPerSec: number;
  shedPerSec: number;
  botBlockedPerSec: number;
  dbDeadlocksPerMin: number;
  retriesPerSec: number;
  outboxBacklog: number;
}

/** Caller → callee traffic; `from: 'customers'` is the synthetic edge into the gateway. */
export interface EdgeStats {
  from: string;
  to: string;
  rps: number;
  p99Ms: number;
  errorPct: number;
}

export type DataStore = 'postgres' | 'redis';

export interface StoreStats {
  service: string;
  store: DataStore;
  opsPerSec: number;
  p99Ms: number;
  errorPct: number;
}

export interface StreamStats {
  producedPerSec: number;
  consumedPerSec: number;
  lag: number;
  dlq: number;
}

export interface HotStockLevel {
  sku: string;
  available: number;
}

export interface Summary {
  ts: number;
  gateway: GatewayStats;
  routes: RouteStats[];
  services: ServiceStats[];
  breakers: BreakerStats[];
  business: BusinessStats;
  sale: Sale | null;
  /*
   * Topology fields. Older control planes don't send them, so they stay undefined
   * (not empty) and the UI can tell "no traffic" from "not reported".
   */
  edges?: EdgeStats[];
  stores?: StoreStats[];
  stream?: StreamStats;
  hotStock?: HotStockLevel[];
}

export interface ServiceHealth {
  service: string;
  up: boolean;
  latencyMs: number;
  startedAt: string | null;
  restarts: number;
  /** Running replicas. Absent on older control planes. */
  instances?: number;
}

export interface ServicesResponse {
  items: ServiceHealth[];
}

/* ------------------------------------------------------------------ SSE */

export type TimelineLevel = 'info' | 'warn' | 'critical';

export interface TimelineEvent {
  id: string | number;
  /** ISO string or epoch milliseconds. */
  ts: string | number;
  level: TimelineLevel;
  source: string;
  kind: string;
  message: string;
  data?: unknown;
}

export interface RecentEventsResponse {
  items: TimelineEvent[];
}

/* ------------------------------------------------------------------ shopper journeys */

export type JourneyPersona = 'shopper' | 'bot';

export type JourneyResult = 'converted' | 'abandoned' | 'failed' | 'blocked' | 'sold_out';

export interface JourneyStep {
  /** Loadgen step label: auth, home, search, category, product, add_to_cart, view_cart, checkout, queue, pay, order_status. */
  step: string;
  /** Click time, relative to the session start. */
  atMs: number;
  /** Latency as the customer felt it. */
  ms: number;
  /** HTTP status; 0 for a timeout or network error. */
  status: number;
  /** Error code from the JSON error body, 'timeout' / 'network' when status is 0, else null. */
  code: string | null;
}

/** One sampled load-generator session, published when it ends (SSE `journey`). */
export interface Journey {
  id: string;
  persona: JourneyPersona;
  /** Epoch ms. */
  startedAt: number;
  durationMs: number;
  result: JourneyResult;
  /** At most 40, ordered by atMs; a longer session keeps its first 39 and its last one. */
  steps: JourneyStep[];
  truncated?: boolean;
  /** The first product page the session viewed. */
  product: { id: number; name: string } | null;
  /** Order total of the order this session paid for. */
  amountCents: number | null;
  /** First waiting-room join → admission or give-up; null if the session never queued. */
  queueWaitMs: number | null;
}

export interface JourneysResponse {
  items: Journey[];
}

/* ------------------------------------------------------------------ Prometheus passthrough */

export interface PromMatrixResult {
  metric: Record<string, string>;
  values: [number, string][];
}

export interface PromQueryRangeResponse {
  status: 'success' | 'error';
  data?: { resultType: string; result: PromMatrixResult[] };
  error?: string;
}
