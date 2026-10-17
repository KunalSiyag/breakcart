// Bot army: scalpers that skip browsing and hammer add-to-cart + checkout on the hot SKUs.
// Each VU is one bot account (reused across attempts) behind a small pool of proxy IPs; bots
// ignore Retry-After and poll the waiting room aggressively.
//
// Pair it with the bot-army lab: with gateway.botProtection=off bots win most hot stock and
// the `bot_success` threshold FAILS; with it on they get 403 BOT_SUSPECTED and it passes.
// Run a flash-sale.js in parallel to see what it does to real shoppers.
//
//   docker run --rm -i --network breakcart_default -v "$PWD/k6/lib.js:/lib.js:ro" grafana/k6 run - < k6/bot-army.js
//
// Env: BASE_URL, MULTIPLIER (default 1), DURATION (default 3m), MAX_VUS (default 400), QTY (default 1).
import { sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { Client, HOT_PRODUCT_IDS, checkout, errorCode, metrics, pay, pick, preflight } from './lib.js';

const M = Number(__ENV.MULTIPLIER || 1);
const QTY = Number(__ENV.QTY || 1);
// TEST-NET-3 addresses: a small residential-proxy pool shared by the whole farm.
const PROXY_POOL = Array.from({ length: 16 }, (_, i) => `203.0.113.${i + 10}`);

const botSuccess = new Rate('bot_success');
const botAttempts = new Counter('bot_attempts');

export const options = {
  scenarios: {
    bots: {
      executor: 'constant-arrival-rate',
      rate: Math.max(1, Math.round(30 * M)),
      timeUnit: '1s',
      duration: __ENV.DURATION || '3m',
      preAllocatedVUs: Math.max(5, Math.round(40 * M)),
      maxVUs: Number(__ENV.MAX_VUS || 400),
    },
  },
  thresholds: {
    // Share of bot attempts that end with a PAID order. Bot protection should keep it low.
    bot_success: ['rate<0.10'],
  },
};

export function setup() {
  return preflight();
}

let bot = null; // per-VU state: each VU is one bot account

export default function () {
  if (!bot) {
    bot = new Client('bot', { ip: pick(PROXY_POOL) });
    if (!bot.login()) {
      bot = null;
      sleep(0.2);
      return;
    }
  }
  botAttempts.add(1);
  bot.del('/api/cart', 'clear_cart');

  // Straight to the cart: no home page, no product view, no think time.
  const productId = pick(HOT_PRODUCT_IDS);
  const add = bot.post('/api/cart/items', { productId, qty: QTY }, 'add_to_cart');
  if (add.status !== 200) {
    const code = errorCode(add);
    if (code === 'BOT_SUSPECTED') metrics.botBlocked.add(1);
    if (code === 'RATE_LIMITED') metrics.rateLimited.add(1);
    botSuccess.add(false);
    return;
  }

  const co = checkout(bot, { maxAttempts: 6, queueWaitSec: 30, pollSec: 0.5, backoff: () => 0.1 });
  if (co.outcome !== 'created' || !co.order) {
    botSuccess.add(false);
    return;
  }
  botSuccess.add(pay(bot, co.order.id, { method: 'card' }) === 'paid');
}
