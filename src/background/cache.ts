import { CHECK_KEY_PREFIX, RESULT_KEY_PREFIX, isCheckRecord, isCheckResult } from "../shared/types";
import type { CheckRecord, CheckResult } from "../shared/types";

export interface CacheStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

const DATA_URL = /^data:([^,]*)(,[\s\S]*)?$/;

// Keeps the media type, drops the payload; a data: URL with no comma keeps nothing.
export function cacheableSrcUrl(srcUrl: string): string {
  const match = DATA_URL.exec(srcUrl);
  if (!match) return srcUrl;
  return match[2] === undefined ? "data:" : `data:${match[1]},`;
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

// chrome.storage.get returns a keyed object; unwrap it. Wired into the worker in #20.
export const sessionStore: CacheStore = {
  get: async (key) => (await chrome.storage.session.get(key))[key],
  set: (key, value) => chrome.storage.session.set({ [key]: value }),
};
