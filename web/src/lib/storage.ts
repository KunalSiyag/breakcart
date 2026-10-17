/**
 * localStorage / sessionStorage wrappers. Storage can throw (private mode, quota,
 * disabled cookies, sandboxed iframes), so every access is guarded and failures
 * degrade to "nothing stored".
 */

interface SafeStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  getJSON<T>(key: string): T | null;
  setJSON(key: string, value: unknown): void;
}

function makeStorage(pick: () => Storage): SafeStorage {
  const get = (key: string): string | null => {
    try {
      return pick().getItem(key);
    } catch {
      return null;
    }
  };
  const set = (key: string, value: string): void => {
    try {
      pick().setItem(key, value);
    } catch {
      /* storage unavailable: keep going without persistence */
    }
  };
  const remove = (key: string): void => {
    try {
      pick().removeItem(key);
    } catch {
      /* ignore */
    }
  };
  return {
    get,
    set,
    remove,
    getJSON<T>(key: string): T | null {
      const raw = get(key);
      if (raw == null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    setJSON(key: string, value: unknown): void {
      try {
        set(key, JSON.stringify(value));
      } catch {
        /* unserialisable value: ignore */
      }
    },
  };
}

export const local = makeStorage(() => window.localStorage);
export const session = makeStorage(() => window.sessionStorage);
