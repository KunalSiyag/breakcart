import { createHash } from 'node:crypto';

/**
 * Same (customer, Idempotency-Key) → same order id. A retry after an attempt that failed
 * half-way finds the order that attempt created, instead of creating a second one.
 */
export function orderIdFor(userId: string, key: string): string {
  const h = createHash('sha256').update(`order:${userId}:${key}`).digest('hex');
  // Shaped like a UUID (version nibble 5, RFC 4122 variant bits) so Postgres's uuid type accepts it.
  // It is SHA-256-derived, not a true name-based v5 UUID (which is SHA-1 over a namespace).
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
