import { useEffect, useLayoutEffect, useState } from 'react';

/*
 * Viewport / layout hooks for the ops console. Kept out of lib/hooks so the storefront
 * bundle doesn't carry them.
 */

/** Live `prefers-reduced-motion: reduce` (follows OS setting changes). */
export function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => {
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(query);
    } catch {
      return;
    }
    const onChange = () => setReduced(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/**
 * Width of an element (give it no padding or border), measured before paint and kept
 * current with a ResizeObserver. Attach the returned callback as its `ref`.
 */
export function useElementWidth<T extends HTMLElement>(): [(el: T | null) => void, number | null] {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w != null) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width];
}

/**
 * `top` for a sticky element that may be taller than the window: `preferred` while it fits,
 * otherwise negative, so it scrolls with the page until its bottom is `gap` above the window's
 * bottom edge and pins there. Attach the returned callback as its `ref`.
 */
export function useStickyTop<T extends HTMLElement>(preferred: number, gap: number): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [top, setTop] = useState(preferred);
  useLayoutEffect(() => {
    if (!el) return;
    const update = () => setTop(Math.min(preferred, Math.round(window.innerHeight - el.getBoundingClientRect().height - gap)));
    update();
    window.addEventListener('resize', update);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(el);
    return () => {
      window.removeEventListener('resize', update);
      ro?.disconnect();
    };
  }, [el, preferred, gap]);
  return [setEl, top];
}
