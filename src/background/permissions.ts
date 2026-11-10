// Host-permission decision logic (PLAN §4 step 1). Pure functions; the
// chrome.permissions calls stay in the worker entry.
//
// permissions.contains does not reflect the activeTab grant (measured, §2),
// so the decision compares origins instead of trusting contains alone: the
// request is needed only when the image origin differs from the tab's
// main-frame origin and <all_urls> is not already granted.

/** "https://host/" -> "https://host/*" (a chrome.permissions origin pattern). */
export function urlOriginPattern(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return `${parsed.origin}/*`;
  } catch {
    return undefined;
  }
}

/**
 * The origin patterns whose coverage this check needs: the frame's origin
 * (injection) and the image's origin (fetch). data: and blob: image URLs have
 * no origin to cover (they are not valid origin patterns), so only the frame
 * origin remains; frames without an http(s) origin (about:blank) need none.
 */
export function originsToCheck(frameUrl: string, srcUrl: string): string[] {
  const frame = urlOriginPattern(frameUrl);
  const image = urlOriginPattern(srcUrl);
  const origins = new Set<string>();
  if (frame) origins.add(frame);
  if (image && image !== frame) origins.add(image);
  return [...origins];
}

/**
 * True when the <all_urls> prompt must be shown before injecting and fetching:
 * the clicked frame's origin (injection) or the image's origin (fetch) differs
 * from the main-frame origin that activeTab covers.
 *
 * Pure URL analysis by design: this runs synchronously inside the menu-click
 * listener, where the user gesture is still live — permissions.request must be
 * the first async call (an awaited contains() drops the gesture; measured by
 * the owner in Brave, PLAN §4 step 1). An already-granted permission resolves
 * request() true without prompting (Chromium keeps granted permissions), so
 * there is no contains() pre-check to avoid redundant prompts.
 */
export function needsPermissionRequest(mainFrameUrl: string, frameUrl: string, srcUrl: string): boolean {
  const main = urlOriginPattern(mainFrameUrl);
  return originsToCheck(frameUrl, srcUrl).some((origin) => origin !== main);
}
