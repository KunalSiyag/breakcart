/**
 * RFC 4122 v4 UUID. `crypto.randomUUID` only exists in secure contexts (https or
 * localhost), so when the lab is opened over plain http on a LAN address we fall
 * back to `crypto.getRandomValues`, which is available everywhere.
 */
export function uuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** First 8 hex chars, upper-case: how order ids and idempotency keys are shown. */
export function shortId(id: string | number | null | undefined): string {
  if (id == null) return '—';
  const s = String(id).replace(/-/g, '');
  return s.slice(0, 8).toUpperCase();
}
