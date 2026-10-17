// Flash sale: an OPEN workload. Shoppers arrive on a schedule (ramping-arrival-rate) whether or
// not the site keeps up — exactly like real customers at 00:00:00 on sale day.
//
//   calm (early birds) → spike when the sale starts → peak → sustained → wind-down
//
// Each iteration is one shopper session (home → product → cart → checkout → pay, with think
// times), see shopperJourney() in lib.js.
//
//   docker run --rm -i --network breakcart_default -v "$PWD/k6/lib.js:/lib.js:ro" grafana/k6 run - < k6/flash-sale.js
//
// Env: BASE_URL (default http://gateway:3000), MULTIPLIER (scales every rate, default 1),
//      MAX_VUS (default 1500), SPOOF_IPS (default true).
//
// k6 does not move the sale clock: the server decides whether the sale is live (GET /api/sale).
// Start the sale from the control plane first if you want the spike to hit a live sale.
import { preflight, shopperJourney } from './lib.js';

const M = Number(__ENV.MULTIPLIER || 1);
const rate = (perSec) => Math.max(1, Math.round(perSec * M));

export const options = {
  scenarios: {
    flash_sale: {
      executor: 'ramping-arrival-rate',
      startRate: rate(2),
      timeUnit: '1s',
      // Little's law: VUs needed ≈ arrivals/s × session seconds (+ time spent in the waiting room).
      preAllocatedVUs: rate(100),
      maxVUs: Number(__ENV.MAX_VUS || 1500),
      stages: [
        { duration: '1m', target: rate(3) }, //   calm: early birds browsing deals
        { duration: '10s', target: rate(40) }, // 00:00:00 — the sale goes live
        { duration: '1m', target: rate(40) }, //  peak
        { duration: '30s', target: rate(15) },
        { duration: '3m', target: rate(15) }, //  sustained
        { duration: '30s', target: 0 }, //        wind-down
      ],
      gracefulStop: '2m', // let shoppers stuck in the waiting room finish their session
    },
  },
  thresholds: {
    // Correct answers: an order, or an honest "sold out". Errors, timeouts and shedding fail it.
    checkout_success: ['rate>0.95'],
    payment_success: ['rate>0.90'],
    // Server-side SLO is p99 < 1s at the gateway; customers see a bit more (network, retries).
    'http_req_duration{endpoint:checkout}': ['p(95)<1500'],
    'http_req_duration{endpoint:pay}': ['p(95)<3000'],
    'http_req_duration{endpoint:home}': ['p(95)<800'],
    'http_req_duration{endpoint:product}': ['p(95)<800'],
    // Only 5xx / transport errors count (4xx are business answers, see lib.js).
    http_req_failed: ['rate<0.02'],
    // An open-model test that cannot start its arrivals is lying about the load it applied.
    dropped_iterations: ['count<1'],
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  return preflight();
}

export default function () {
  shopperJourney({ buyShare: 0.65, hotShare: 0.75, couponShare: 0.25 });
}

