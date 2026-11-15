// Finding the image for a srcUrl (PLAN §5): the script is injected after
// the click, so it cannot know which element was right-clicked. It matches
// <img> elements whose currentSrc or src equals the srcUrl the browser
// reported. src is resolved against the element's baseURI so relative srcs
// and pages with a <base> element still match.

interface ImageSource {
  readonly src: string;
  readonly currentSrc: string;
  readonly baseURI?: string;
}

function resolvedSrc(source: ImageSource): string {
  if (!source.baseURI) return source.src;
  try {
    return new URL(source.src, source.baseURI).href;
  } catch {
    return source.src;
  }
}

export function matchesSrcUrl(img: unknown, srcUrl: string): boolean {
  const source = img as Partial<ImageSource> | null;
  if (typeof source?.src !== "string" || typeof source.currentSrc !== "string") return false;
  if (source.currentSrc === srcUrl) return true;
  if (source.src === "") return false;
  return resolvedSrc(source as ImageSource) === srcUrl;
}

export function findImages(srcUrl: string, root: ParentNode = document): HTMLImageElement[] {
  return [...root.querySelectorAll("img")].filter((img) => matchesSrcUrl(img, srcUrl));
}

// The upload flow re-reads a page's data: image after the cache stripped its
// payload (PLAN §3), so it can only match by the prefix that is left. An empty
// prefix must never match, or every image would qualify. The returned value is
// the source that actually matched, so a caller fetches that URL and not a
// different candidate (a srcset currentSrc, say).
export function matchedSrcPrefix(img: unknown, prefix: string): string | undefined {
  if (prefix === "") return undefined;
  const source = img as Partial<ImageSource> | null;
  if (typeof source?.src !== "string" || typeof source.currentSrc !== "string") return undefined;
  if (source.currentSrc.startsWith(prefix)) return source.currentSrc;
  if (source.src === "") return undefined;
  const resolved = resolvedSrc(source as ImageSource);
  return resolved.startsWith(prefix) ? resolved : undefined;
}

/** The first image source that matches the prefix, not the first image. */
export function findSourceByPrefix(prefix: string, root: ParentNode = document): string | undefined {
  for (const img of root.querySelectorAll("img")) {
    const source = matchedSrcPrefix(img, prefix);
    if (source !== undefined) return source;
  }
  return undefined;
}

/**
 * The URL to read for a payload-free data: source. Two data: images of the same
 * type share the stripped prefix, so a remembered URL wins — but only when it is
 * longer than the stored prefix, i.e. actually carries a payload: the worker's
 * own OpenAI done update sends the payload-free form, and reading that would
 * fetch an empty image. Otherwise the first prefix match is used and the
 * worker's hash check rejects it rather than uploading the wrong image.
 */
export function dataUrlToRead(stored: string, knownSource: string | undefined, root: ParentNode = document): string | undefined {
  if (knownSource !== undefined && knownSource.length > stored.length && knownSource.startsWith(stored)) {
    return knownSource;
  }
  return findSourceByPrefix(stored, root);
}

export const MAX_REMEMBERED_DATA_URLS = 16;
export const MAX_REMEMBERED_DATA_CHARS = 8 * 1024 * 1024;

/**
 * Remembers the data: URL each check was about, oldest evicted first. Bounded by
 * count and by total characters, because a data: URL is as large as the image it
 * carries; one too large to keep is left to the prefix match and the hash check.
 */
export function rememberDataUrl(remembered: Map<string, string>, checkId: string, srcUrl: string): void {
  if (!srcUrl.startsWith("data:")) {
    remembered.delete(checkId);
    return;
  }
  // The worker's OpenAI done update repeats the payload-free URL; the full one
  // must not be replaced by it, or a later read fetches an empty image.
  const existing = remembered.get(checkId);
  if (existing !== undefined && existing.length >= srcUrl.length) return;
  remembered.delete(checkId);
  if (srcUrl.length > MAX_REMEMBERED_DATA_CHARS) return;
  remembered.set(checkId, srcUrl);
  let total = 0;
  for (const url of remembered.values()) total += url.length;
  for (const [oldest, url] of remembered) {
    if (remembered.size <= MAX_REMEMBERED_DATA_URLS && total <= MAX_REMEMBERED_DATA_CHARS) break;
    remembered.delete(oldest);
    total -= url.length;
  }
}
