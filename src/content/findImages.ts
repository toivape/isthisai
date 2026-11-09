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
