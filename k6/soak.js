// Soak: moderate, constant arrival rate for a long time. Nothing should get worse with time —
// if latency creeps up, memory climbs (Services → "Resident memory"), stock leaks into phantom
// holds or the outbox backlog grows, you have a leak. Labs: memory-leak, phantom-sellout, gc-pauses.
//
//   docker run --rm -i --network breakcart_default -v "$PWD/k6/lib.js:/lib.js:ro" grafana/k6 run - < k6/soak.js
//
// Env: BASE_URL, MULTIPLIER (default 1 → 5 sessions/s), DURATION (default 30m), MAX_VUS (default 400).
import { preflight, shopperJourney } from './lib.js';

const M = Number(__ENV.MULTIPLIER || 1);

export const options = {
  scenarios: {
    soak: {
      executor: 'constant-arrival-rate',
      rate: Math.max(1, Math.round(5 * M)),
      timeUnit: '1s',
      duration: __ENV.DURATION || '30m',
      preAllocatedVUs: Math.max(10, Math.round(80 * M)),
      maxVUs: Number(__ENV.MAX_VUS || 400),
      gracefulStop: '1m',
    },
  },
  thresholds: {
    checkout_success: ['rate>0.99'],
    payment_success: ['rate>0.95'],
    http_req_failed: ['rate<0.005'],
    http_req_duration: ['p(99)<1000'],
    'http_req_duration{endpoint:home}': ['p(95)<500'],
    'http_req_duration{endpoint:checkout}': ['p(95)<1000'],
    dropped_iterations: ['count<1'],
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  return preflight();
}

export default function () {
  // Mostly regular catalog items so the soak is not dominated by hot SKUs selling out.
  shopperJourney({ buyShare: 0.5, hotShare: 0.15, couponShare: 0.05 });
}
