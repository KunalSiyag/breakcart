import { local } from './storage';

/**
 * Deterministic product "photography": a gradient tile + emoji derived from the
 * product's imageSeed and category. No external image hosts, stable across reloads.
 */

const CATEGORY_EMOJI: [RegExp, string[]][] = [
  [/phone|mobile|smartphone/i, ['📱', '📲']],
  [/laptop|computer|notebook|pc\b/i, ['💻', '🖥️']],
  [/audio|headphone|earbud|speaker|sound|music/i, ['🎧', '🔊', '🎵']],
  [/tv|television|display|monitor/i, ['📺', '🖥️']],
  [/camera|photo/i, ['📷', '📸']],
  [/gaming|game|console/i, ['🎮', '🕹️']],
  [/watch|wearable/i, ['⌚']],
  [/electronic|gadget|tech|accessor/i, ['🔌', '🔋', '💡', '🖱️']],
  [/shoe|footwear|sneaker/i, ['👟', '👠', '🥾']],
  [/fashion|cloth|apparel|wear|shirt|dress/i, ['👕', '👗', '🧥', '👖']],
  [/bag|luggage|travel/i, ['🎒', '👜', '🧳']],
  [/jewel|gold/i, ['💍', '📿']],
  [/beauty|cosmetic|makeup|skincare|personal/i, ['💄', '🧴', '💅']],
  [/kitchen|cook|dining/i, ['🍳', '🥘', '🔪']],
  [/appliance/i, ['🧺', '🌀', '🧊']],
  [/home|decor|furnish|furniture|living/i, ['🛋️', '🪴', '🕯️', '🛏️']],
  [/grocery|food|snack|gourmet/i, ['🛒', '🥫', '🍫', '☕']],
  [/toy|kid|baby/i, ['🧸', '🪀', '🍼']],
  [/book|stationery|office/i, ['📚', '✏️', '📓']],
  [/sport|fitness|gym|outdoor/i, ['🏋️', '⚽', '🚴', '🏸']],
  [/health|pharma|wellness/i, ['💊', '🩺']],
  [/pet/i, ['🐾', '🦴']],
  [/auto|car|bike|motor/i, ['🚗', '🏍️', '🛞']],
  [/garden|plant/i, ['🌿', '🪴']],
  [/tool|hardware|diy/i, ['🛠️', '🔧']],
];

const FALLBACK_EMOJI = ['🎁', '📦', '✨', '🛍️', '⭐', '🏷️'];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface ProductArt {
  background: string;
  emoji: string;
  rotateDeg: number;
}

export function productArt(imageSeed: number, category: string | null | undefined): ProductArt {
  const seed = Number.isFinite(imageSeed) ? Math.abs(Math.floor(imageSeed)) : 0;
  const cat = category ?? '';
  const base = hash(cat || 'misc') % 360;
  const hue = (base + ((seed * 47) % 90) - 45 + 360) % 360;
  const hue2 = (hue + 28 + (seed % 23)) % 360;
  const light = 88 + (seed % 5);
  const background = [
    `radial-gradient(circle at ${20 + (seed % 60)}% ${15 + ((seed * 7) % 30)}%, hsl(${hue} 100% 97% / 0.9) 0, transparent 42%)`,
    `radial-gradient(circle at ${85 - (seed % 30)}% 90%, hsl(${hue2} 90% 70% / 0.45) 0, transparent 55%)`,
    `linear-gradient(${120 + (seed % 90)}deg, hsl(${hue} 85% ${light}%), hsl(${hue2} 80% 78%))`,
  ].join(', ');

  const entry = CATEGORY_EMOJI.find(([re]) => re.test(cat));
  const pool = entry ? entry[1] : FALLBACK_EMOJI;
  const emoji = pool[seed % pool.length] ?? '🎁';
  const rotateDeg = (seed % 21) - 10;
  return { background, emoji, rotateDeg };
}

/* Cart lines carry imageSeed but not category, and order items carry neither; remember
   what we've seen on product cards so a product gets the same tile everywhere. */
const MEMO_KEY = 'breakcart.products.v1';
type MemoEntry = [category: string, imageSeed: number];
let memo: Record<string, MemoEntry> | null = null;
let memoTimer: number | undefined;

function loadMemo(): Record<string, MemoEntry> {
  if (memo) return memo;
  const parsed = local.getJSON<unknown>(MEMO_KEY);
  memo = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, MemoEntry>) : {};
  return memo;
}

export function rememberProducts(products: readonly { id: number; category: string; imageSeed: number }[]): void {
  const m = loadMemo();
  let changed = false;
  for (const p of products) {
    if (!p || p.id == null) continue;
    const k = String(p.id);
    const prev = m[k];
    if (!prev || prev[0] !== p.category || prev[1] !== p.imageSeed) {
      m[k] = [p.category ?? '', Number(p.imageSeed) || 0];
      changed = true;
    }
  }
  if (!changed) return;
  window.clearTimeout(memoTimer);
  memoTimer = window.setTimeout(() => {
    const keys = Object.keys(m);
    if (keys.length > 800) for (const k of keys.slice(0, keys.length - 800)) delete m[k];
    local.setJSON(MEMO_KEY, m);
  }, 500);
}

export function knownProduct(productId: number): { category: string; imageSeed: number } | null {
  const e = loadMemo()[String(productId)];
  return Array.isArray(e) ? { category: e[0], imageSeed: e[1] } : null;
}
