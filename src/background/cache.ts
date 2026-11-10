// Session cache (PLAN §4 "Cache"): pure logic over a small injected storage
// interface, so the rules are unit-testable without chrome. The real store
// wraps chrome.storage.session (cleared when the browser closes); results and
// check records only — never image bytes (PLAN §4 "Cache").

import { CHECK_KEY_PREFIX, RESULT_KEY_PREFIX, isCheckRecord, isCheckResult } from "../shared/types";
import type { CheckRecord, CheckResult } from "../shared/types";

export interface CacheStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

const DATA_URL = /^data:([^,]*),[\s\S]*$/;

// A data: URL carries the encoded image in its payload, so caching it verbatim
// would store image bytes and exhaust the 10 MiB session quota (PLAN §4
// "Cache"). Keep the scheme and media type, drop the payload: the record stays
// payload-free, and the upload flow recovers data: images from the page the
// same way it does blob: ones (PLAN §4 step 8.3).
export function cacheableSrcUrl(srcUrl: string): string {
  const match = DATA_URL.exec(srcUrl);
  return match ? `data:${match[1]},` : srcUrl;
}

export async function putCheck(store: CacheStore, record: CheckRecord): Promise<void> {
  const safe = { ...record, srcUrl: cacheableSrcUrl(record.srcUrl) };
  await store.set(`${CHECK_KEY_PREFIX}${record.checkId}`, safe);
}

export async function getCheck(store: CacheStore, checkId: string): Promise<CheckRecord | undefined> {
  const value = await store.get(`${CHECK_KEY_PREFIX}${checkId}`);
  return isCheckRecord(value) ? value : undefined;
}

export async function putResult(store: CacheStore, result: CheckResult): Promise<void> {
  await store.set(`${RESULT_KEY_PREFIX}${result.imageHash}`, result);
}

export async function getResult(store: CacheStore, imageHash: string): Promise<CheckResult | undefined> {
  const value = await store.get(`${RESULT_KEY_PREFIX}${imageHash}`);
  return isCheckResult(value) ? value : undefined;
}

// The real store: chrome.storage.session, so entries are cleared when the
// browser closes and image hashes are never kept as long-term history
// (PLAN §4 "Cache"). chrome.storage.get returns a keyed object; unwrap it.
// Wired into the worker in #20.
export const sessionStore: CacheStore = {
  get: async (key) => (await chrome.storage.session.get(key))[key],
  set: (key, value) => chrome.storage.session.set({ [key]: value }),
};
