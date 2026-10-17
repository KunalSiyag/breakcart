// Smoke test: one virtual user walks every public endpoint once and checks the responses
// against docs/contract.md §2. Run it after `docker compose up` and after every change.
//
//   docker run --rm -i --network breakcart_default -v "$PWD/k6/lib.js:/lib.js:ro" grafana/k6 run - < k6/smoke.js
import { check, group } from 'k6';
import { Client, checkout, json, pay, preflight } from './lib.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1.0'],
    http_req_failed: ['rate==0'],
  },
};

export function setup() {
  return preflight();
}

const is200 = (r) => r.status === 200;

export default function () {
  const c = new Client('shopper');
  check(c.login(), { 'POST /api/auth/guest returns a token': (ok) => ok === true });

  // A regular catalog item: plenty of stock and no hot-SKU bot rules.
  const productId = 13 + Math.floor(Math.random() * 5000);

  group('browse', () => {
    const home = c.get('/api/home', 'home');
    const h = json(home) || {};
    check(home, {
      'GET /api/home 200': is200,
      'home has sale, deals and recommendations': () => !!h.sale && Array.isArray(h.deals) && Array.isArray(h.recommendations),
    });

    const sale = c.get('/api/sale', 'sale');
    check(sale, { 'GET /api/sale 200': is200, 'sale has startsAt/endsAt/live': (r) => 'live' in (json(r) || {}) });

    const cats = c.get('/api/categories', 'categories');
    const items = (json(cats) || {}).items || [];
    check(cats, { 'GET /api/categories 200': is200, 'categories not empty': () => items.length > 0 });

    const category = items.length ? encodeURIComponent(items[0].name) : '';
    const list = c.get(`/api/products?category=${category}&page=1&pageSize=24`, 'products');
    check(list, {
      'GET /api/products 200': is200,
      'products page has items + total': (r) => Array.isArray((json(r) || {}).items) && typeof (json(r) || {}).total === 'number',
    });

    const product = c.get(`/api/products/${productId}`, 'product');
    check(product, {
      'GET /api/products/:id 200': is200,
      'product has price and priceVersion': (r) => {
        const p = json(r) || {};
        return typeof p.priceCents === 'number' && typeof p.priceVersion === 'number';
      },
    });

    const search = c.get('/api/search?q=acme', 'search');
    check(search, { 'GET /api/search 200': is200, 'search reports tookMs': (r) => typeof (json(r) || {}).tookMs === 'number' });
  });

  group('cart', () => {
    check(c.del('/api/cart', 'clear_cart'), { 'DELETE /api/cart 200': is200 });
    const add = c.post('/api/cart/items', { productId, qty: 1 }, 'add_to_cart');
    check(add, {
      'POST /api/cart/items 200': is200,
      'cart contains the product': (r) => ((json(r) || {}).items || []).some((l) => l.productId === productId),
    });
    const cart = c.get('/api/cart', 'cart');
    check(cart, { 'GET /api/cart 200': is200, 'cart has subtotal': (r) => (json(r) || {}).subtotalCents > 0 });
    check(c.del(`/api/cart/items/${productId}`, 'remove_item'), { 'DELETE /api/cart/items/:id 200': is200 });
    check(c.post('/api/cart/items', { productId, qty: 1 }, 'add_to_cart'), { 're-add item 200': is200 });
  });

  group('checkout & pay', () => {
    const co = checkout(c, { queueWaitSec: 60 });
    check(co, {
      'checkout created an order (or answered sold out / sale not started)': (r) =>
        ['created', 'sold_out', 'sale_not_started'].includes(r.outcome),
    });
    if (co.outcome !== 'created' || !co.order) return;
    check(co.order, { 'new order is AWAITING_PAYMENT': (o) => o.status === 'AWAITING_PAYMENT' });

    const result = pay(c, co.order.id, { method: 'upi' });
    check(result, { 'payment ends PAID or DECLINED': (r) => r === 'paid' || r === 'declined' });

    const one = c.get(`/api/orders/${co.order.id}`, 'order_status');
    check(one, { 'GET /api/orders/:id 200': is200 });
    const mine = c.get('/api/orders', 'my_orders');
    check(mine, { 'GET /api/orders 200': is200, 'my orders lists the order': (r) => ((json(r) || {}).items || []).length > 0 });
  });
}
