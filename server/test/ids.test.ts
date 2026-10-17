import { describe, expect, it } from 'vitest';
import { orderIdFor } from '../src/services/orders/ids';

describe('orderIdFor', () => {
  it('is deterministic per (customer, idempotency key)', () => {
    expect(orderIdFor('u_1', 'key-123456')).toBe(orderIdFor('u_1', 'key-123456'));
  });

  it('differs across customers and keys (one customer cannot collide with another)', () => {
    const ids = new Set([orderIdFor('u_1', 'k-1-aaaaaa'), orderIdFor('u_2', 'k-1-aaaaaa'), orderIdFor('u_1', 'k-2-aaaaaa')]);
    expect(ids.size).toBe(3);
  });

  it('is a valid version-5 UUID that Postgres accepts', () => {
    for (let i = 0; i < 200; i++) {
      const id = orderIdFor(`u_${i}`, `key-${i}-xxxxxxxx`);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});
