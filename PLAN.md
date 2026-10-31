# Browser extension: on-demand AI image check ("TÄ" badge)

Plan for a Manifest V3 extension for Brave (works in any Chromium browser). The user right-clicks an image, or clicks a small button on the image, to check whether it carries AI-provenance signals. If it does, the image is marked with the text **TÄ** (tekoäly).

Work through the milestones in order. Each has acceptance criteria; do not start the next milestone until they pass.

**Method: pragmatic TDD.** Logic that is easy to test (sniffing, verdict merging, API parsing, error mapping, caching) is built test-first (red, green, refactor), as described in `CLAUDE.md`. Where TDD is impractical (browser UI, context menu, permissions, service worker behaviour), skip it and rely on manual testing in Brave instead of writing complicated test code; add those items to the manual checklist in section 9. At the start of each milestone, list the planned tests by name for review.

---

## 1. Goals and non-goals

**Goals**
- Check a single image **on user request** (never scan whole pages automatically).
- Free, local, private checks first. Paid/remote check only on explicit user action.
- Mark detected images with a **TÄ** badge (tooltip: "Tekoäly") and show a small result popup explaining which signal matched.
- The user supplies their own OpenAI API key in an options page.
- UI in Finnish and English.

**Non-goals**
- No automatic page-wide scanning, no background network calls without a user action.
- No ML "looks AI" classifier. Only provenance signals (C2PA, metadata, SynthID via OpenAI API).
- No claim that an unmarked image is real. Wording is always "no AI signal found".
- No automation of synthid.com (its terms prohibit programmatic/bulk use; it has a daily quota of roughly 10 checks). Only offer a link for manual use.

---

## 2. Background facts the design depends on

- EU AI Act Article 50 has applied since 2 Aug 2026. Providers must mark AI output with signed metadata plus an imperceptible watermark, and must offer a detection mechanism. A watermark-detection interoperability solution is due 2 Feb 2027, so there is no universal detector yet.
- **OpenAI Content Provenance API** (docs: https://developers.openai.com/api/docs/guides/content-provenance):
  - `POST https://api.openai.com/v1/content_provenance_checks`, header `Authorization: Bearer <key>`, multipart field `file`, one file per request.
  - Images: PNG, JPEG, WebP only. Max 50 MiB.
  - Do **not** set the `Content-Type` header manually. Let `fetch` + `FormData` set the multipart boundary. Set the file part's real media type (`image/jpeg`, not `image/jpg`).
  - Response has `results[]` with a `c2pa` entry and a `synthid` entry (images). There is no top-level verdict. Each has `outcome: "detected" | "not_detected"`.
  - C2PA entry also has `validation_state` (`trusted | valid | invalid | not_present`), `issuer`, `model`, `generated_at`.
  - It only detects **OpenAI** signals. `not_detected` proves nothing.
  - Errors: 400 bad/unsupported file, 404 org without access, 429 rate limit (honour `Retry-After`).
  - Rate limits are described as strict (no numbers published). **Pricing is not stated in the guide: check https://developers.openai.com/api/docs/pricing and tell users the check may be billed.**
- Re-encoding the image (for example drawing it on a canvas) destroys both metadata and watermark. **Always send/inspect the original bytes.**
- C2PA metadata is often stripped by CDNs, screenshots and re-saves. SynthID lives in the pixels and survives more edits. Either signal is enough to show TÄ.
- Verified test results from the project owner's own key:
  - `ai-test-halloween.png` (original ChatGPT image): `c2pa` detected (trusted, issuer "OpenAI OpCo, LLC", model "ChatGPT / gpt-image") and `synthid` detected.
  - `ai-tes-iceland.jpg` (phone photo): both `not_detected`, c2pa `validation_state: "not_present"`.

---

## 3. Architecture

```
┌──────────────┐  context menu / hover button   ┌─────────────────────┐
│ Content      │ ─────────────────────────────▶ │ Service worker      │
│ script       │                                 │ (background)        │
│ - hover btn  │ ◀───────────────────────────── │ - fetch image bytes │
│ - TÄ badge   │   result message               │ - local checks      │
│ - popup      │                                 │ - OpenAI API call   │
└──────────────┘                                 │ - cache             │
                                                 └─────────────────────┘
        Options page: API key, settings, privacy text
```

- **Service worker** does everything that needs the network or heavy parsing. The API key is only ever read here and never sent to page scripts.
- **Content script** only handles UI on the page. Put all injected UI in a **Shadow DOM** so page CSS cannot break it and the page cannot read it.
- For `data:` and `blob:` image URLs the service worker cannot fetch them, so the content script reads the bytes (via `fetch(url)` in the page context) and sends them to the worker as an `ArrayBuffer`.

### Tech choices
- TypeScript, Vite (or esbuild) multi-entry build, Vitest for unit tests.
- `c2pa` npm package (c2pa-js) for Content Credentials. **Verify early that it runs in an MV3 service worker** (WASM may need `'wasm-unsafe-eval'` in the extension CSP and bundled `.wasm` as web-accessible or loaded by URL). If it does not run in the worker, run the C2PA parse in an offscreen document (`chrome.offscreen`) and message the result back.
- `exifr` for EXIF/IPTC/XMP parsing.
- No remote code, no analytics, no external fonts.

### Planned file layout
```
/
├─ manifest.json
├─ package.json, tsconfig.json, vite.config.ts
├─ _locales/en/messages.json
├─ _locales/fi/messages.json
├─ src/
│  ├─ background/
│  │  ├─ index.ts            # menu registration, message router
│  │  ├─ fetchImage.ts       # download bytes, size limit, sniff type
│  │  ├─ sniff.ts            # magic-byte media type detection
│  │  ├─ localChecks.ts      # C2PA + XMP/IPTC checks
│  │  ├─ openaiCheck.ts      # API call + response parsing
│  │  ├─ verdict.ts          # combine signals -> result model
│  │  └─ cache.ts            # result cache keyed by SHA-256 of bytes
│  ├─ content/
│  │  ├─ index.ts            # message handling, find <img> for a URL
│  │  ├─ hoverButton.ts      # button shown over images on hover
│  │  ├─ badge.ts            # TÄ badge overlay
│  │  └─ popup.ts            # result popup (Shadow DOM)
│  ├─ options/
│  │  ├─ options.html
│  │  └─ options.ts
│  └─ shared/
│     ├─ types.ts            # CheckResult, Signal, messages
│     └─ i18n.ts
└─ test/
   ├─ fixtures/              # see section 9
   └─ *.test.ts
```

### Manifest outline (MV3)
- `permissions`: `contextMenus`, `storage`, `activeTab`, `scripting` (add `offscreen` only if needed for C2PA).
- Host access: `optional_host_permissions: ["<all_urls>"]`, requested at first use ("Allow the extension to download images you check"). Needed so the worker can fetch cross-origin image bytes. Also needs `https://api.openai.com/*` (can be a normal host permission).
- `background.service_worker`, `content_scripts` on `<all_urls>` (document_idle, only registers listeners, no scanning), `options_ui`.
- `default_locale: "en"`, `name`/`description` via `__MSG_...__`.
- `minimum_chrome_version` set to a recent Chromium that Brave tracks.

---

## 4. Check pipeline (service worker)

Triggered only by a user action (context-menu click or hover-button click). Input: image URL (or bytes for data/blob URLs), plus tab/frame ids.

1. **Fetch bytes.** `fetch(url, {credentials: "omit"})`. Reject over 50 MiB. Sniff the media type from magic bytes (do not trust the `Content-Type` header or file extension). Compute SHA-256 of the bytes.
2. **Cache lookup** by SHA-256. If a result exists (and the OpenAI step was already done, or not requested), return it.
3. **Local checks** (free, offline, nothing leaves the machine):
   - C2PA manifest: parse and validate. Record `issuer`, validation state, whether an AI-generation action (`c2pa.created` with digital source type of trained algorithmic media) is present, generator/model if present.
   - XMP/IPTC: `Iptc4xmpExt:DigitalSourceType` equal to `trainedAlgorithmicMedia` or `compositeWithTrainedAlgorithmicMedia` (match on the IPTC URI ending), plus generator names in software/creator-tool fields as a weak hint (shown as "possible", does not by itself trigger TÄ).
4. **Verdict from local checks.** Strong local signal means TÄ is shown immediately, and no OpenAI call is offered as necessary.
5. **If no strong local signal:** show "No AI signal found in the file's metadata" with action buttons:
   - **Check watermark with OpenAI** (only enabled if an API key is configured and the image type is PNG/JPEG/WebP).
   - **Open synthid.com** (manual check; see section 6).
6. **OpenAI check** (only after the user clicks, with the first-use confirmation, see section 7). Send the original bytes. Parse the response. Merge into the result. Cache by SHA-256.

### Verdict model (`CheckResult`)
```ts
type SignalState = "detected" | "not_detected" | "not_checked" | "error";

interface CheckResult {
  imageHash: string;
  aiSignal: boolean;                 // true => show TÄ
  signals: {
    localC2pa:   { state: SignalState; issuer?: string; validation?: string; model?: string; generatedAt?: string; aiAction?: boolean };
    localMeta:   { state: SignalState; digitalSourceType?: string; generatorHint?: string };
    openaiC2pa:  { state: SignalState; issuer?: string; validation?: string; model?: string; generatedAt?: string };
    openaiSynthId: { state: SignalState; model?: string; generatedAt?: string };
  };
  error?: { code: "unsupported_type" | "too_large" | "fetch_failed" | "no_key" | "http_400" | "http_404" | "rate_limited" | "network"; retryAfterSec?: number };
}
```

**TÄ rule:** `aiSignal = true` if any of these is `detected`: local C2PA with an AI-generation action, local metadata DigitalSourceType, OpenAI C2PA, OpenAI SynthID. A C2PA manifest from a non-AI source (for example a camera) is **not** an AI signal; show its issuer in the popup but no TÄ.

---

## 5. UI behaviour

**Triggers (both)**
- Context menu item on images: title "Check if AI-generated" / "Tarkista onko tekoälyn tekemä". Uses `contexts: ["image"]`; click info gives `srcUrl`.
- Hover button: small round button (top-left corner of an image larger than about 100x100 px) appearing on hover; click starts the check. Rendered in a Shadow DOM host appended to `document.documentElement` and positioned from `getBoundingClientRect()` (reposition on scroll/resize). One shared button element, not one per image. No scanning of images in advance: attach a single `mouseover` listener on the document.

**States shown on the image**
- Checking: spinner on the button.
- AI signal found: **TÄ** badge over the image corner (tooltip "Tekoäly"); clicking it opens the popup.
- No signal: no badge. A brief toast "No AI signal found (this does not prove the image is real)" and the popup with the action buttons from pipeline step 5.
- Error: toast with a short message and retry hint.

**Popup content** (Shadow DOM, closes on Esc / outside click)
- Headline: "AI signal found" or "No AI signal found".
- Two labelled lines: "Content Credentials (C2PA)" and "Watermark (SynthID)", each with the state and details (issuer, model, time).
- Always show the caveat line: "No signal does not mean the image is human-made."
- Buttons as in pipeline step 5.

**Finding the element for a URL:** after a context-menu click, the content script locates the `<img>` whose `currentSrc` or `src` matches `srcUrl` (prefer the one last right-clicked: record `contextmenu` event targets). For CSS background images and elements without a matching `<img>`, show the popup anchored at the click point and skip the badge.

**Badge persistence:** keep badges only for the life of the page (a `WeakRef` map of element to result). Do not store browsing history.

---

## 6. synthid.com fallback (manual, no automation)

Button "Check on synthid.com". Behaviour: copy the image to the clipboard (when possible) or offer a download, then open https://synthid.com in a new tab, with a short instruction ("Upload the image there. Free, about 10 checks per day, sign-in needed"). The extension must **not** drive the upload or read results from that site.

---

## 7. API key, privacy and safety

- Options page field for the OpenAI API key (password-type input, "Test key" button that runs a check on a tiny built-in sample and reports success/401/404 without exposing the key).
- Store in `chrome.storage.local` (not `sync`). Read only in the service worker. Never log it, never put it in URLs, never send it to content scripts.
- Advise users in the options text to create a **dedicated project key with a spend limit** in the OpenAI dashboard.
- **First-use confirmation before every OpenAI upload** (checkbox "Don't ask again" stored in settings): "This image will be sent to OpenAI to check for provenance signals. Checks may be billed to your OpenAI account."
- The extension makes no network requests other than: fetching the image the user chose, and the OpenAI call the user confirmed.
- Privacy section in the options page and store listing, stating exactly this.
- Handle `data:`/`blob:` and cross-origin fetch failures gracefully (explain that the site blocked the download).
- Never try to evade or reverse watermarks (OpenAI's usage guidance forbids repeated queries to do so). Cache by hash so the same image is not re-sent.

---

## 8. Internationalisation

- `_locales/en` and `_locales/fi`. All user-visible strings through `chrome.i18n.getMessage` (or a small wrapper for the Shadow DOM UI).
- Badge text is the literal **TÄ** in both locales. Tooltip "Tekoäly" (fi) and "AI-generated (tekoäly)" (en).
- Before release, check the final Finnish wording used in the EU Code of Practice icon annex (the EU "AI" icon is localised per language) and align the badge/tooltip if it differs.

---

## 9. Testing

**Fixtures** (`test/fixtures/`, owner supplies the real files):
- `ai-test-halloween.png`: original ChatGPT image. Expect OpenAI c2pa `detected` (trusted) and synthid `detected`. Expect local C2PA to detect an AI action too.
- `ai-tes-iceland.jpg`: phone photo. Expect everything `not_detected`, c2pa `not_present`.
- Derived files to generate in a test script: screenshot or JPEG re-save of the halloween image (metadata stripped). Expect local checks `not_detected`; OpenAI synthid likely still `detected` (manual verification, record the actual result).
- A WebP, a GIF, an AVIF, and a file over 50 MiB for error paths.

**Unit tests (Vitest):** magic-byte sniffing, verdict merging (every combination of signal states), OpenAI response parsing (use the real sample responses above as fixtures), error mapping (400/404/429 with `Retry-After`), cache keys.

**Mocking:** mock `fetch` for the OpenAI endpoint. No real API calls in CI. Provide an opt-in script `npm run test:live` that reads `OPENAI_API_KEY` from the environment and checks the two fixtures.

**Manual test checklist** (run in Brave with the extension loaded via `brave://extensions` > Developer mode > Load unpacked):
1. Right-click an image on a normal site: menu item appears; non-image elements do not show it.
2. Hover button appears over large images only; does not appear over small icons; works in iframes and on dynamically added images.
3. Check on a page with images from a different origin (CDN): optional host permission prompt appears once and the fetch works.
4. Brave Shields on and off: note any difference in image fetching.
5. Dark mode and light mode pages: popup and badge stay readable.
6. No key set: OpenAI button disabled with an explanation. Wrong key: clear 401 message. Rate limit: shows retry time.

---

## 10. Milestones

**M0. Scaffold**
- Repo, TypeScript, build, manifest, empty service worker, loads in Brave without errors.
- Accept: extension loads; `npm run build` and `npm test` run.

**M1. Context menu and UI shell**
- Menu on images; message to content script; Shadow DOM host; popup with placeholder text; fake "TÄ" badge on the right-clicked image.
- Accept: right-click image shows TÄ badge and popup on a normal website, including in an iframe.

**M2. Fetch and sniff**
- `fetchImage`, magic-byte sniff, size limit, SHA-256, `data:`/`blob:` handling, optional host permission flow.
- Accept: type and size correctly reported for the fixtures and a cross-origin CDN image.

**M3. Local checks**
- C2PA parse/validate (decide worker vs offscreen after a spike), XMP/IPTC DigitalSourceType.
- Accept: halloween fixture shows an AI signal locally with issuer OpenAI; phone photo shows none.

**M4. Options and OpenAI check**
- Options page, key storage, test-key button, confirmation dialog, API call, response parsing, error mapping, cache.
- Accept: with a valid key, both fixtures give the expected results; errors display the right messages; the same image is not sent twice.

**M5. Verdict and result UI**
- Verdict merging, final popup layout with two signal lines and caveat, toasts, action buttons including synthid.com fallback.
- Accept: all rows of the signal-state matrix render sensibly; screenshots re-saved without metadata are handled as described in section 9.

**M6. Hover button**
- Single shared hover button, positioning, ignores small images, repositions on scroll/resize, keyboard accessible (focusable, Enter/Space).
- Accept: works on at least five varied real sites without breaking their layout.

**M7. i18n and polish**
- Finnish and English strings, tooltips, icons for the extension, error wording review, a11y (aria-labels, focus handling, contrast).
- Accept: switching browser language to Finnish shows Finnish UI everywhere.

**M8. Packaging**
- Production build, README (install, usage, privacy, limits), store-listing text (clear privacy statement), version 0.1.0 zip.
- Accept: fresh-profile install works from the zip.

---

## 11. Open questions to resolve during implementation

1. Does c2pa-js run inside the MV3 service worker as is? If not, use an offscreen document.
2. Exact pricing and default rate limits of the Content Provenance API (check the OpenAI pricing page; not stated in the guide). Update the confirmation text accordingly.
3. Does the OpenAI SynthID check also detect Google/other partner watermarks via this API? The docs only promise "supported OpenAI signals", so assume no and say so in the UI.
4. Final Finnish label from the EU Code of Practice icon annex.
5. Whether to add Google's or other providers' checks later (only if an official public API appears; synthid.com must stay manual).

---

## 12. Result wording (for consistency)

- Found: "AI signal found" / "Tekoälyn merkki löytyi"
- Not found: "No AI signal found. This does not prove the image is human-made." / "Tekoälyn merkkiä ei löytynyt. Se ei todista, että kuva on ihmisen tekemä."
- Never use "real", "fake", "verified human" or "verified authentic".
