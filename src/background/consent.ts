// The worker-side half of the upload confirmation (PLAN §4 step 8.2, hard rule
// 5): the OpenAI flow waits for exactly one answer per open check, and an answer
// is refused unless it came from the extension's own confirmation page. The
// window itself is opened in index.ts, which only feeds answers in here.

export interface ConsentSender {
  url?: string | undefined;
}

export type ConsentAnswer = "accepted" | "refused" | "unknown";

// The sender URL is the discriminator, not the presence of a tab: an injected
// content script reports the *page's* URL, which can never be the extension's
// own chrome-extension:// origin (same boundary as the options-page check).
export function isConsentSender(sender: ConsentSender, confirmUrlPrefix: string): boolean {
  return typeof sender.url === "string" && sender.url.startsWith(confirmUrlPrefix);
}

/**
 * The open confirmations, keyed by checkId. Deliberately in memory: a stopped
 * worker drops them, a late answer is then "unknown" and the user simply checks
 * again. Persisting the map would not help, because the promise it feeds cannot
 * be persisted either.
 */
export class PendingConsents {
  private readonly waiters = new Map<string, (confirmed: boolean) => void>();

  constructor(private readonly confirmUrlPrefix: string) {}

  /** Registers a check and settles when its window answers or is removed. */
  open(checkId: string): Promise<boolean> {
    // A second window for the same check supersedes the first: declining the
    // earlier one frees its flow instead of leaving it waiting forever.
    this.decline(checkId);
    return new Promise((resolve) => {
      this.waiters.set(checkId, resolve);
    });
  }

  /**
   * Applies a confirmUpload. Only the confirmation page may answer, and only
   * for a check that is actually open; anything else changes nothing, so a
   * forged message cannot resolve a pending upload.
   */
  answer(checkId: string, sender: ConsentSender, confirmed: boolean): ConsentAnswer {
    if (!isConsentSender(sender, this.confirmUrlPrefix)) return "refused";
    const resolve = this.waiters.get(checkId);
    if (resolve === undefined) return "unknown";
    this.waiters.delete(checkId);
    resolve(confirmed);
    return "accepted";
  }

  /** A removed window declines, never a silent nothing (hard rule 5). */
  decline(checkId: string): boolean {
    const resolve = this.waiters.get(checkId);
    if (resolve === undefined) return false;
    this.waiters.delete(checkId);
    resolve(false);
    return true;
  }
}
