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

/** True when the <all_urls> prompt must be shown before fetching. */
export function needsPermissionRequest(mainFrameUrl: string, srcUrl: string, containsAllUrls: boolean): boolean {
  if (containsAllUrls) return false;
  const main = urlOriginPattern(mainFrameUrl);
  const image = urlOriginPattern(srcUrl);
  if (!image) return false; // data:/blob: or same-scheme-less cases
  return image !== main;
}
