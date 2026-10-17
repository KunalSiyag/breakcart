import client from 'prom-client';
import { config } from './config';

/**
 * All metric definitions live here so names stay consistent with docs/contract.md §5.
 * Metrics a given service never touches simply emit no samples.
 */
export const registry = new client.Registry();
registry.setDefaultLabels({ service: config.service });
client.collectDefaultMetrics({ register: registry, eventLoopMonitoringPrecision: 10 });

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const FAST_BUCKETS = [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

const counter = <L extends string>(name: string, help: string, labelNames: readonly L[] = []) =>
  new client.Counter<L>({ name, help, labelNames, registers: [registry] });
const gauge = <L extends string>(name: string, help: string, labelNames: readonly L[] = []) =>
  new client.Gauge<L>({ name, help, labelNames, registers: [registry] });
const histogram = <L extends string>(name: string, help: string, labelNames: readonly L[], buckets = LATENCY_BUCKETS) =>
  new client.Histogram<L>({ name, help, labelNames, buckets, registers: [registry] });

export const m = {
  // HTTP server
  httpDuration: histogram('http_server_request_duration_seconds', 'Inbound HTTP request latency', ['method', 'route', 'status']),
  httpInflight: gauge('http_server_inflight_requests', 'Inbound HTTP requests in flight'),
  httpErrors: counter('http_server_errors_total', 'Error responses by route and error code', ['route', 'code']),

  // HTTP client
  clientDuration: histogram('http_client_request_duration_seconds', 'Outbound HTTP call latency (incl. retries)', ['target', 'outcome']),
  clientRetries: counter('http_client_retries_total', 'Outbound retries', ['target']),
  clientConnections: counter('http_client_connections_opened_total', 'TCP connections opened to an upstream', ['target']),
  clientBudgetExhausted: counter('http_client_retry_budget_exhausted_total', 'Retries skipped because the retry budget was empty', ['target']),
  breakerState: gauge('circuit_breaker_state', 'Circuit breaker state (0 closed, 1 half-open, 2 open)', ['target']),
  breakerTransitions: counter('circuit_breaker_transitions_total', 'Circuit breaker transitions', ['target', 'to']),

  // DB
  dbPool: gauge('db_pool_connections', 'Postgres pool connections by state', ['state']),
  dbAcquire: histogram('db_pool_acquire_duration_seconds', 'Time waiting for a pooled connection', [], FAST_BUCKETS),
  dbQuery: histogram('db_query_duration_seconds', 'Query latency (incl. connection acquire)', ['op', 'outcome']),
  dbErrors: counter('db_errors_total', 'DB errors by SQLSTATE', ['code']),

  // Redis
  redisCmd: histogram('redis_command_duration_seconds', 'Redis command latency', ['op', 'outcome'], FAST_BUCKETS),

  // Cache
  cacheRequests: counter('cache_requests_total', 'Cache lookups', ['cache', 'result']),
  cacheRebuilds: counter('cache_rebuilds_total', 'Cache entry rebuilds (DB loads); tier=hot for flash-deal keys', ['cache', 'tier']),
  cacheRebuildInflight: gauge('cache_rebuild_inflight', 'Concurrent cache rebuilds in this process', ['cache']),

  chaosActive: gauge('chaos_active', 'Active chaos injections in this process', ['kind']),
  clockOffset: gauge('clock_offset_seconds', 'Offset of this service\'s business clock from real time'),
  replicaLag: gauge('db_replica_lag_seconds', 'Simulated replica lag applied to order-history reads'),
  runtimeFlag: gauge('runtime_flag', 'Current mode of each runtime flag (1 = active mode)', ['flag', 'mode']),

  // Gateway
  rateLimit: counter('gateway_ratelimit_decisions_total', 'Rate limiter decisions', ['decision']),
  shed: counter('gateway_shed_total', 'Requests shed by load shedding (reason: inflight limit or queueing delay)', ['priority', 'reason']),
  admissionInflight: gauge('gateway_admission_inflight', 'Admission slots the load shedder believes are in use (compare with http_server_inflight_requests)'),
  waitingRoomLength: gauge('gateway_waiting_room_queue_length', 'Users waiting in the virtual waiting room'),
  waitingRoomAdmitted: counter('gateway_waiting_room_admitted_total', 'Waiting room admissions (passes issued)'),
  waitingRoomRejected: counter('gateway_waiting_room_rejected_total', 'Checkouts rejected for missing/invalid pass'),
  botBlocked: counter('gateway_bot_blocked_total', 'Requests blocked as bots', ['reason']),
  sessionsCreated: counter('gateway_sessions_created_total', 'Guest sessions created'),

  // Inventory
  reservations: counter('inventory_reservations_total', 'Reservation attempts', ['strategy', 'result']),
  reservationDuration: histogram('inventory_reservation_duration_seconds', 'Reservation latency', ['strategy']),
  expiredReservations: counter('inventory_expired_reservations_total', 'Reservations released by the TTL sweeper'),
  availableUnits: gauge('inventory_available_units', 'Available units for hot SKUs', ['sku']),

  // Orders
  checkouts: counter('orders_checkouts_total', 'Checkout attempts', ['result']),
  payments: counter('orders_payments_total', 'Payment attempts', ['result']),
  gmv: counter('orders_gmv_cents_total', 'Gross merchandise value of paid orders (cents)'),
  reconciled: counter('orders_reconciled_total', 'Payment reconciliations', ['result']),
  eventsPublished: counter('orders_events_published_total', 'Order events published', ['mode', 'result']),
  couponRedemptions: counter('orders_coupon_redemptions_total', 'Coupon redemption attempts', ['result']),

  // PSP
  pspCharges: counter('psp_charges_total', 'PSP charge requests', ['result']),
  pspChargedCents: counter('psp_charged_cents_total', 'Amount successfully charged (cents)'),

  // Workers
  streamLag: gauge('stream_consumer_lag', 'Entries not yet delivered to the consumer group', ['stream', 'group']),
  streamPending: gauge('stream_pending_messages', 'Delivered but unacknowledged entries', ['stream', 'group']),
  streamProcessed: counter('stream_processed_total', 'Stream messages processed', ['result']),
  dlqLength: gauge('stream_dlq_length', 'Dead letter queue length'),
  outboxUnpublished: gauge('outbox_unpublished', 'Outbox rows not yet relayed'),
  outboxRelayed: counter('outbox_relayed_total', 'Outbox rows relayed'),

  // Control plane
  integrity: gauge('integrity_violations', 'Business invariant violations', ['kind']),
  businessOrders: gauge('business_orders', 'Orders by status (from the database)', ['status']),

  // Loadgen
  lgStep: histogram('loadgen_step_duration_seconds', 'Customer-experienced latency per funnel step', ['step', 'outcome']),
  lgRequests: counter('loadgen_requests_total', 'Loadgen requests by step and status code', ['step', 'code']),
  lgActive: gauge('loadgen_sessions_active', 'Active virtual user sessions'),
  lgSessions: counter('loadgen_sessions_total', 'Finished sessions', ['persona', 'result']),
  lgTarget: gauge('loadgen_arrival_rate_target', 'Target session arrival rate (/s)'),
  lgDropped: counter('loadgen_arrivals_dropped_total', 'Arrivals dropped because the generator hit its session cap'),
  lgArrivals: counter('loadgen_arrivals_total', 'Sessions started', ['persona']),
  lgAnomalies: counter('loadgen_anomalies_total', 'User-visible anomalies observed by virtual users', ['kind']),
};

export async function metricsText(): Promise<string> {
  return registry.metrics();
}
