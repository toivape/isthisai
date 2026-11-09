// Idempotent injection guard (PLAN §3): the worker may inject this script
// into the same frame again for another image, and a second run must reuse
// the existing instance instead of duplicating the UI. The instance lives
// on the frame's global object; the content script is a classic IIFE, so
// each injection gets a fresh module map and module-level state is not enough.

export function installOnce<T>(key: string, create: () => T): T {
  const page = globalThis as unknown as Record<string, T | undefined>;
  const existing = page[key];
  if (existing) return existing;
  const instance = create();
  page[key] = instance;
  return instance;
}
