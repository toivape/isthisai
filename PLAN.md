# Browser extension: on-demand AI image check ("TÄ" badge)

Plan for a Manifest V3 extension for Brave (works in any Chromium browser). The user right-clicks an image and picks a menu item to check whether it carries AI-provenance signals. If it does, the image is marked with the text **TÄ** (tekoäly).

Work through the milestones in order. Each has acceptance criteria; do not start the next milestone until they pass.

**Method: pragmatic TDD.** Logic that is easy to test (sniffing, XMP scanning, C2PA result mapping, verdict, API parsing, error mapping, caching) is built test-first (red, green, refactor), as described in `CLAUDE.md`. Where TDD is impractical (browser UI, context menu, permissions, service worker behaviour), skip it and rely on manual testing in Brave instead of writing complicated test code; add those items to the manual checklist in section 8. At the start of each milestone, list the planned tests by name for review.

**Who runs what.** Implementation is done by a coding agent that cannot run Brave. Spike measurements and every manual check are run by the project owner in Brave. An implementer lists the manual checks for the owner in the PR and never reports them as done or invents measured values.

---

## 1. Goals and non-goals

**Goals**
- Check a single image **on user request** via the right-click context menu (never scan pages automatically).
- Free, local, private checks first. Paid/remote check only on explicit user action.
- Mark detected images with a **TÄ** badge and show a small result popup explaining which signal matched.
- The user supplies their own OpenAI API key in an options page.
- UI in Finnish and English.

**Non-goals**
- No automatic page-wide scanning, no background network calls without a user action.
- No hover button or other UI injected before the user picks the menu item.
- No ML "looks AI" classifier. Only provenance signals (C2PA, XMP metadata, SynthID via OpenAI API).
- No claim that an unmarked image is human-made. Wording is always "no AI signal found".
- No synthid.com integration of any kind (no public API; its terms prohibit automation).

---

## 2. Background facts the design depends on

- EU AI Act Article 50 has applied since 2 Aug 2026. Providers must mark AI output with signed metadata plus an imperceptible watermark, and must offer a detection mechanism. A watermark-detection interoperability solution is due 2 Feb 2027, so there is no universal detector yet.
- **OpenAI Content Provenance API** (docs: https://developers.openai.com/api/docs/guides/content-provenance):
  - `POST https://api.openai.com/v1/content_provenance_checks`, header `Authorization: Bearer <key>`, multipart field `file`, one file per request.
  - Images: PNG, JPEG, WebP only. Max 50 MiB.
  - Do **not** set the `Content-Type` header manually. Let `fetch` + `FormData` set the multipart boundary. Set the file part's real media type (`image/jpeg`, not `image/jpg`).
  - Response has `results[]` with a `c2pa` entry and a `synthid` entry (images). There is no top-level verdict. Each has `outcome: "detected" | "not_detected"`. Missing details are `null`.
  - C2PA entry also has `validation_state` (`trusted | valid | invalid | not_present`), `issuer`, `model`, `generated_at`.
  - It only detects **OpenAI** signals. `not_detected` proves nothing.
  - Errors: 400 bad/unsupported file, 401 bad key, 404 org without access, 429 rate limit (honour `Retry-After`).
  - Rate limits are described as strict (no numbers published). **Pricing is not stated in the guide: check https://developers.openai.com/api/docs/pricing and tell users the check may be billed.**
  - Real responses for both fixtures are in `test/fixtures/openai-*.json`.
- Re-encoding the image (for example drawing it on a canvas) destroys both metadata and watermark. **Always send/inspect the original bytes.**
- C2PA metadata is often stripped by CDNs, screenshots and re-saves. SynthID lives in the pixels and survives more edits. Either signal is enough to show TÄ.
- Verified OpenAI API results from the project owner's own key:
  - `ai-test-halloween.png` (original ChatGPT image): `c2pa` detected (trusted, issuer "OpenAI OpCo, LLC", model "ChatGPT / gpt-image") and `synthid` detected.
  - `ai-tes-iceland.jpg` (phone photo): both `not_detected`, c2pa `validation_state: "not_present"`.
  - `ai-test-halloween-resaved.jpg` (the halloween image re-saved as JPEG, metadata stripped): c2pa `not_detected` (`not_present`), **synthid `detected`**. Local C2PA gives `JumbfNotFound` and the file has no XMP packet. The watermark survives a re-save; the metadata does not.
- **Local C2PA library, verified 2026-10-31:**
  - The `c2pa` npm package is deprecated in favour of `@contentauth/c2pa-web`.
  - `@contentauth/c2pa-web` always spawns a Web Worker (`new Worker(...)`; a custom `workerSrc` must be `https:`). Service workers have no `Worker`, so it cannot be used in the service worker.
  - Its lower-level dependency `@contentauth/c2pa-wasm` (0.13.x) exposes `WasmReader.fromBytes(format, Uint8Array, contextJson?)`, which uses no browser-only APIs. Run in Node against the fixtures:
    - `ai-test-halloween.png`: parsed in ~50 ms. Issuer "OpenAI OpCo, LLC". Active manifest action `c2pa.created` with `softwareAgent` `{name: "ChatGPT", version: "gpt-image"}` and `digitalSourceType` `http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia`, plus `c2pa.watermarked.unbound`. `validation_state: "Valid"` (not `Trusted`: `signingCredential.untrusted`, because no trust anchors are configured).
    - `ai-tes-iceland.jpg`: throws `C2pa(JumbfNotFound)`. This means "no manifest". GIF, WebP and JPEG files without a manifest give the same error. Truncated or garbage files give `InvalidAsset`.
  - **It makes network requests by default.** An image whose XMP contains `dcterms:provenance="<url>"` (a remote manifest reference) makes `fromBytes` call `fetch(<url>)`, so any page could use a checked image as a tracking beacon. Passing `{"verify":{"remote_manifest_fetch":false,"ocsp_fetch":false}}` as `contextJson` stops it; the call then fails with `C2pa(RemoteManifestUrl("<url>"))` and no fetch happens. **Always pass this setting.**
  - The `.wasm` is about 9 MB. The glue has no default wasm URL; pass the module or `chrome.runtime.getURL(...)` explicitly.
- **exifr** (considered for XMP) supports only JPEG, TIFF, PNG, HEIC, AVIF (no WebP, no GIF) and has not been released since May 2022. Not used.
- **Chrome extension facts (developer.chrome.com, checked 2026-10-31):**
  - Extension messaging uses JSON serialisation; the maximum message size is 64 MiB.
  - `activeTab` grants host permission for the tab's **main frame** origin only, after a context-menu click (among other gestures).
  - A service worker is stopped when "a `fetch()` response takes more than 30 seconds to arrive", when a single event or API call takes over 5 minutes, or after 30 s of inactivity.
  - `chrome.storage.local` is exposed to content scripts by default; `storage.local.setAccessLevel()` can restrict it to trusted contexts. `storage.session` is not exposed to content scripts, has a 10 MB quota and is cleared on browser restart and extension reload/update.
  - Web pages cannot message the extension unless `externally_connectable` is declared (it is not).

---

## 3. Architecture

```
┌──────────────┐  context-menu click (srcUrl, frameUrl, frameId)
│ Context menu │ ───────────────────────────────────▶ ┌─────────────────────┐
└──────────────┘                                      │ Service worker      │
┌──────────────┐  injected on demand into that frame  │ (background)        │
│ Content      │ ◀─────────────────────────────────── │ - fetch image bytes │
│ script (UI)  │   checkUpdate messages               │ - local checks      │
│ - TÄ badge   │ ───────────────────────────────────▶ │ - OpenAI API call   │
│ - popup      │   openaiRequest {checkId}, blob read │ - cache             │
└──────────────┘                                      └─────────┬───────────┘
┌──────────────────────────────┐   confirmUpload {checkId}      │
│ Confirmation window          │ ◀──────────────────────────────┘
│ (extension page, popup type) │   opened with chrome.windows.create
└──────────────────────────────┘
        Options page: API key (write-only), test-key button, privacy text
```

- **Service worker** does everything that needs the network or heavy parsing. The API key is only ever read here and never sent to page scripts.
- **Content script** is not declared in the manifest. The worker injects it with `chrome.scripting.executeScript` into `info.frameId` only after a menu click. Injection must be idempotent (a global "already loaded" guard), because the user may check several images on the same page.
- The content script only handles UI on the page. Put all injected UI in a **closed Shadow DOM** so page CSS cannot break it. Page scripts can still restyle, hide or move the host element, so the in-page UI is **never trusted for consent**: the OpenAI upload is confirmed in an extension-origin window.
- **Confirmation window:** `confirm.html`, an extension page opened with `chrome.windows.create({type: "popup"})`. It shows the image origin, type and size and the billing note, with Upload / Cancel. It does not load the image (no extra request). Shown before **every** upload; there is no "don't ask again".
- **Restricted frames** (`chrome://`, the Web Store, other extensions' pages, `about:blank`/`srcdoc` frames that cannot be injected): if injection fails, show the result in the same extension window instead of on the page.
- **Messaging is JSON-only.** Never put raw binary in a message.
- **`data:` URLs:** the worker fetches them directly.
- **`blob:` URLs:** only the page can read them. The worker asks the content script (`readBlob`), which fetches the blob and replies base64-encoded. Cap this path at 45 MiB (60 MiB base64, under the 64 MiB message limit). A revoked blob URL gives `fetch_failed`.

### Messages and storage
Defined in `src/shared/types.ts` (add new message types there first):

```ts
// worker -> content script
type CheckUpdate =
  | { type: "checkUpdate"; checkId: string; srcUrl: string; status: "checking" }
  | { type: "checkUpdate"; checkId: string; srcUrl: string; status: "done"; result: CheckResult; openai: OpenAiAvailability }
  | { type: "checkUpdate"; checkId: string; srcUrl: string; status: "failed"; error: CheckError };
type OpenAiAvailability = { available: true } | { available: false; reason: "no_key" };
// worker -> content script, request/response
type ReadBlob = { type: "readBlob"; checkId: string; url: string };        // reply: { ok: true; base64: string } | { ok: false }
// content script -> worker
type OpenAiRequest = { type: "openaiRequest"; checkId: string };            // worker validates sender.tab.id/frameId against the stored check
// confirmation window -> worker
type ConfirmUpload = { type: "confirmUpload"; checkId: string; confirmed: boolean };
// options page -> worker, request/response
type TestKey = { type: "testKey" };                                         // reply: { ok: true } | { ok: false; error: OpenAiError }
type KeyStatus = { type: "keyStatus" };                                     // reply: { hasKey: boolean }
```

Storage:
- `chrome.storage.local`: `{ apiKey?: string }`. The worker calls `chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })` on every start, so content scripts cannot read it. The options page writes or clears the key and never reads it back.
- `chrome.storage.session`:
  - `check:<checkId>`: `{ checkId, srcUrl, frameUrl, tabId, frameId, imageHash, mediaType, size }`, written when the local check finishes.
  - `result:<imageHash>`: `CheckResult`.

### Tech choices
- TypeScript, Vite (or esbuild) multi-entry build, Vitest for unit tests.
- `@contentauth/c2pa-wasm` for Content Credentials, called via `WasmReader.fromBytes` directly in the service worker, always with remote fetches disabled (section 2). Needs `'wasm-unsafe-eval'` in the extension CSP and the `.wasm` bundled in the extension. Initialise lazily inside the event handler (module service workers do not allow top-level `await`; listeners must be registered synchronously). Call `free()` on readers. If the M0 spike shows it cannot run in the worker, fall back to an offscreen document (`chrome.offscreen`) and add the `offscreen` permission.
- No C2PA trust list in v0.1 (bundling one goes stale; downloading one breaks the no-extra-requests rule). Locally read issuer and model are shown as **claimed (signer not verified)**.
- XMP: a small own scanner that finds the XMP packet (`<x:xmpmeta` … `</x:xmpmeta>`) in the raw bytes, which works for JPEG, PNG (uncompressed iTXt), WebP, GIF and AVIF/HEIC alike. Compressed PNG text chunks are not supported (documented limitation). No XMP library.
- No remote code, no analytics, no external fonts.

### Planned file layout
```
/
├─ manifest.json
├─ package.json, tsconfig.json, vite.config.ts, vitest.live.config.ts
├─ _locales/en/messages.json
├─ _locales/fi/messages.json
├─ src/
│  ├─ background/
│  │  ├─ index.ts            # menu registration, injection, message router
│  │  ├─ check.ts            # orchestration: fetch -> sniff -> cache -> local checks -> verdict -> notify
│  │  ├─ fetchImage.ts       # download bytes, timeout, streaming size limit
│  │  ├─ sniff.ts            # magic-byte media type detection
│  │  ├─ c2pa.ts             # c2pa-wasm call + result mapping
│  │  ├─ xmp.ts              # XMP packet scanner + DigitalSourceType mapping
│  │  ├─ openai.ts           # request building, response parsing, error mapping
│  │  ├─ openaiFlow.ts       # confirmation, re-fetch, upload, merge
│  │  ├─ verdict.ts          # verdict from signals, merge OpenAI result
│  │  └─ cache.ts            # session cache of checks and results
│  ├─ content/
│  │  ├─ index.ts            # injected entry, idempotent guard, find <img> for a URL, readBlob
│  │  ├─ badge.ts            # TÄ badge overlay
│  │  └─ popup.ts            # result popup, toasts (Shadow DOM)
│  ├─ confirm/               # confirmation / fallback result window (extension page)
│  ├─ options/
│  │  ├─ options.html
│  │  └─ options.ts
│  ├─ assets/sample.png      # tiny image without provenance, for the test-key button
│  └─ shared/
│     ├─ types.ts            # CheckResult, errors, messages, storage shapes
│     └─ i18n.ts             # getMessage wrapper; key naming convention
└─ test/
   ├─ fixtures/              # see section 8
   ├─ live/*.live.ts         # only run by npm run test:live
   └─ *.test.ts
```

### Manifest outline (MV3)
- `permissions`: `contextMenus`, `storage`, `activeTab`, `scripting` (add `offscreen` only if the C2PA spike needs it).
- `host_permissions`: `https://api.openai.com/*`.
- `optional_host_permissions: ["<all_urls>"]`, requested once at first use ("Allow the extension to download images you check"). Needed because `activeTab` covers only the main frame's origin; images from another origin (CDN) and cross-origin iframes need it.
- No `content_scripts` entry. No `externally_connectable`.
- `content_security_policy.extension_pages`: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.
- `background.service_worker` (type module), `options_ui`.
- `default_locale: "en"`, `name`/`description` via `__MSG_...__`.
- `minimum_chrome_version`: the owner supplies the Chromium version of the current Brave release in M0.

---

## 4. Check pipeline (service worker)

Triggered only by a context-menu click. Input: `info.srcUrl`, `info.frameUrl`, `tab.id`, `info.frameId`. A new `checkId` is created per click.

1. **Host permission.** Needed for the frame origin (injection) and the image origin (fetch); `data:` and `blob:` image URLs need none. If not covered (`chrome.permissions.contains`), request `<all_urls>`. The M0 spike decides whether `permissions.request` works inside `contextMenus.onClicked` and whether `contains` reflects `activeTab`; if the request is not allowed there, open the extension window with an "Allow" button. Declined: `permission_denied`.
2. **Inject the UI script** into the frame and send `checkUpdate {status: "checking"}`. If injection fails, use the extension window for the result.
3. **Fetch bytes.** `fetch(url, {credentials: "omit", headers: {Accept: <Brave's image Accept value>}, signal})`. Abort if the response has not arrived within 25 s (`timeout`; Chrome stops the worker at 30 s). Stop reading once more than 50 MiB has arrived (`too_large`; do not download everything and then check). `blob:` bytes come from the content script (section 3). Non-2xx or network failure: `fetch_failed` with the "the site blocked the download" hint (hotlink protection, login-only images).
4. **Sniff** the media type from magic bytes (never `Content-Type` or the extension). Local checks run for PNG, JPEG, WebP, GIF, AVIF and HEIC; anything else (unknown bytes, SVG, BMP): `unsupported_type`. Compute SHA-256.
5. **Cache lookup** by SHA-256 (`result:<hash>`). If found, use it.
6. **Local checks** (free, offline, nothing leaves the machine):
   - C2PA: `WasmReader.fromBytes(mediaType, bytes, '{"verify":{"remote_manifest_fetch":false,"ocsp_fetch":false}}')`. Mapping in section 4 "Result model".
   - XMP: scan for the XMP packet and read `Iptc4xmpExt:DigitalSourceType` (match on the IPTC URI ending). Generator names in `xmp:CreatorTool` / software fields are a weak hint only.
7. **Verdict, cache, notify.** Compute the verdict, write `result:<hash>` and `check:<checkId>`, send `checkUpdate {status: "done"}` with `openai` availability (`no_key` if no key is stored; the media type does not disable the button, see step 8.4).
8. **OpenAI check** (only after the user clicks the popup button):
   1. Content script sends `openaiRequest {checkId}`. The worker loads `check:<checkId>` and checks that `sender.tab.id` and `sender.frameId` match. Missing record (browser restarted, extension reloaded): `check_expired` ("check the image again").
   2. The worker opens the confirmation window. Nothing is uploaded unless the user clicks Upload there.
   3. The worker fetches the stored `srcUrl` again (or asks for the blob again) and checks the SHA-256 against the record (`hash_mismatch` otherwise; no upload).
   4. If the bytes are AVIF, HEIC or GIF (not accepted by OpenAI), the worker fetches again with `Accept: image/webp,image/png,image/jpeg`. If the server returns an accepted type, that version is uploaded and the result is marked `serverConverted: true` (the popup says the server may have re-encoded the image, which can remove signals). If not: `unsupported_type`. The hash check does not apply to this second fetch.
   5. Upload the bytes with the sniffed media type (section 2). Parse the response, merge into the cached result, send `checkUpdate {status: "done"}`. OpenAI errors are shown but never cached.
9. **Interrupted checks.** If the content script gets no `done`/`failed` within 60 s of `checking` (worker stopped), it shows "Check interrupted, try again".

### Cache
- `chrome.storage.session` only (cleared when the browser closes; image hashes are not kept as long-term history). So "not sent twice" holds within one browser session.
- Store results and check records only, never image bytes.
- Whole-check failures (`CheckError`) and OpenAI errors are never cached, so a retry really retries. Local signal-level errors (for example a corrupt manifest) are deterministic and are cached with the result.
- No "check again" in v0.1: a cached result is shown as is.

### Result model
```ts
interface CheckResult {
  imageHash: string;
  mediaType: string;
  verdict: "ai_signal" | "no_signal" | "incomplete";
  localC2pa: {
    manifest: "absent" | "present" | "invalid" | "remote_unfetched" | "error";
    aiAction: boolean;                 // see TÄ rule
    claimedIssuer?: string;            // from the signing certificate; not verified without a trust list
    claimedModel?: string;             // softwareAgent "name / version"
    generatedAt?: string;
  };
  localXmp: { state: "detected" | "not_detected" | "error"; digitalSourceType?: string; generatorHint?: string };
  openai:
    | { state: "not_checked" }
    | { state: "done"; serverConverted: boolean;
        c2pa: { outcome: "detected" | "not_detected"; validation?: "trusted" | "valid" | "invalid" | "not_present"; issuer?: string; model?: string; generatedAt?: string };
        synthid: { outcome: "detected" | "not_detected"; model?: string; generatedAt?: string } };
}

type CheckError = { code: "permission_denied" | "fetch_failed" | "timeout" | "too_large" | "unsupported_type" };

type OpenAiError = {
  code: "no_key" | "cancelled" | "check_expired" | "hash_mismatch" | "unsupported_type" | "fetch_failed" | "timeout"
      | "http_400" | "http_401" | "http_404" | "http_4xx" | "http_5xx" | "rate_limited" | "network" | "bad_response";
  retryAfterSec?: number;
};
```

C2PA mapping:
- `JumbfNotFound` → `absent`. `RemoteManifestUrl(...)` → `remote_unfetched`. Other parser errors (`InvalidAsset`, …) → `error`.
- `validation_state` `Valid` or `Trusted` → `present`; `Invalid` → `invalid`.
- `aiAction` is true if the active manifest, or an ingredient manifest that the active manifest references and whose own validation passed, has an action whose `digitalSourceType` ends in `trainedAlgorithmicMedia` or `compositeWithTrainedAlgorithmicMedia`.

### TÄ rule
`verdict = "ai_signal"` if any of:
- `localC2pa.manifest === "present"` and `localC2pa.aiAction`.
- `localXmp.state === "detected"` (DigitalSourceType ends in `trainedAlgorithmicMedia` or `compositeWithTrainedAlgorithmicMedia`). The popup labels it as unsigned metadata.
- OpenAI `c2pa.outcome === "detected"` with validation `trusted` or `valid` (same validation policy as local).
- OpenAI `synthid.outcome === "detected"`.

Otherwise `verdict = "incomplete"` if `localC2pa.manifest` is `error` or `remote_unfetched`, or `localXmp.state === "error"`; else `"no_signal"`.

Not an AI signal (show details in the popup, no TÄ):
- A C2PA manifest from a non-AI source (for example a camera).
- A C2PA manifest with AI actions but `invalid` validation (shown as "manifest present but invalid; the image may have been edited").
- `algorithmicMedia` and `compositeSynthetic` (not machine-learning generated by IPTC definition).
- Generator-name hints in software fields.

---

## 5. UI behaviour

**Trigger:** one context menu item on images: title "Check for AI signals" / "Tarkista tekoälyn merkit". Uses `contexts: ["image"]`; click info gives `srcUrl`, `frameUrl` and `frameId`.

**Known limitation:** on sites that lay a transparent element over images (for example Instagram, Pinterest), the right-click hits that element, so the browser does not offer the image menu item. Workaround for users: open the image in its own tab and right-click it there. State this in the README.

**States shown on the image**
- Checking: small spinner over the image corner.
- AI signal found: **TÄ** badge over the image corner (tooltip "Tekoäly" / "AI signal found (tekoäly)"); clicking it opens the popup.
- No signal: no badge. A brief toast "No AI signal found. This does not prove the image is human-made." and the popup.
- Check incomplete: no badge; popup explains which check could not finish.
- Error: toast with a short message and retry hint (retry time for 429).

**Popup content** (Shadow DOM, closes on Esc / outside click)
- Headline: "AI signal found", "No AI signal found" or "Check incomplete".
- Three labelled lines, each with state and details:
  - "Content Credentials (C2PA)": local result (issuer and model shown as claimed, signer not verified; "manifest present but invalid"; "manifest stored elsewhere, not downloaded"). After an OpenAI check, add OpenAI's result (for example "verified by OpenAI: trusted").
  - "Metadata (XMP, unsigned)".
  - "Watermark (SynthID, via OpenAI)": "not checked" plus the "Check with OpenAI" button (disabled with the reason if no key), or the result. If `serverConverted`, say the server may have re-encoded the image.
- Always show the caveat line: "No signal does not mean the image is human-made."
- Next to the OpenAI result: "OpenAI detects only OpenAI signals."

**Page scripts must not be able to trigger uploads.** Button handlers in the injected UI ignore events where `event.isTrusted` is false, and the upload itself is only confirmed in the extension window.

**Finding the element for a URL:** the content script is injected after the click, so it cannot know which element was right-clicked. It looks in its frame for `<img>` elements whose `currentSrc` or `src` matches `srcUrl` and badges all of them. If none match (CSS background images, `<picture>` edge cases), show the popup in a fixed corner of the viewport and skip the badge.

**Badge persistence:** keep badges only for the life of the page (a `WeakMap` of element to result inside the injected script). Do not store browsing history.

---

## 6. API key, privacy and safety

- Options page field for the OpenAI API key (password-type input). **Write-only:** it shows "key saved" / "no key" (from the worker's `keyStatus`) and a clear button; it never reads the key back.
- "Test key" button: the worker uploads the bundled tiny sample (`src/assets/sample.png`, no provenance) and reports success/401/404/429. The button text says it sends a sample image to OpenAI and may be billed; clicking it is the confirmation (it is not the user's image).
- Store in `chrome.storage.local` with access level `TRUSTED_CONTEXTS` (not `sync`). Read only in the service worker. Never log it, never put it in URLs, never send it to content scripts.
- Advise users in the options text to create a **dedicated project key with a spend limit** in the OpenAI dashboard.
- **Confirmation in the extension window before every OpenAI upload:** "This image will be sent to OpenAI to check for provenance signals. Checks may be billed to your OpenAI account." No "don't ask again".
- The extension makes no network requests other than: fetching the image the user chose, and the OpenAI call the user confirmed. c2pa-wasm remote fetches are always disabled.
- Privacy section in the options page and README, stating exactly this.
- Handle `data:`/`blob:` and cross-origin fetch failures gracefully (explain that the site blocked the download).
- Never try to evade or reverse watermarks (OpenAI's usage guidance forbids repeated queries to do so). Cache by hash so the same image is not re-sent.

---

## 7. Internationalisation

- `_locales/en` and `_locales/fi`. All user-visible strings through `chrome.i18n.getMessage` via `src/shared/i18n.ts`, from the first UI issue on (no hardcoded strings at any stage).
- Badge text is the literal **TÄ** in both locales. Tooltip "Tekoäly" (fi) and "AI signal found (tekoäly)" (en).
- Before release, check the final Finnish wording used in the EU Code of Practice icon annex (the EU "AI" icon is localised per language) and align the badge/tooltip if it differs.

---

## 8. Testing

**Fixtures** (`test/fixtures/`):
- `ai-test-halloween.png`: original ChatGPT image. Expect OpenAI c2pa `detected` (trusted) and synthid `detected`. Expect local C2PA `present` with an AI action, claimed issuer "OpenAI OpCo, LLC", claimed model "ChatGPT / gpt-image".
- `ai-tes-iceland.jpg`: phone photo. Expect local C2PA `absent`, XMP `not_detected`, OpenAI both `not_detected` with c2pa `not_present`.
- `ai-test-halloween-resaved.jpg`: JPEG re-save of the halloween image (metadata stripped, made outside the extension). Expect local C2PA `absent`, XMP `not_detected`, OpenAI c2pa `not_detected` and synthid `detected`.
- `openai-halloween.json`, `openai-iceland.json`, `openai-halloween-resaved.json`: real OpenAI responses, used as parser fixtures.
- Small test inputs (XMP packets in JPEG/PNG/WebP/GIF containers, a PNG with a remote manifest reference, truncated files) are built by test helpers in code, not committed as files. Do **not** commit a file over 50 MiB: test the size limit with a fake stream.

**Unit tests (Vitest):** magic-byte sniffing, XMP scanning in every container, C2PA mapping (runs `@contentauth/c2pa-wasm` in Node against the fixtures; asserts that `fetch` is never called, including for the remote-reference PNG), verdict (every row of the TÄ rule and the not-an-AI-signal cases), OpenAI request building, response parsing and error mapping, streaming size limit, cache rules, OpenAI flow decisions (expired check, sender mismatch, hash mismatch, server conversion, cancel).

**Mocking:** mock `fetch` for the OpenAI endpoint. No real API calls in `npm test`. `npm run test:live` uses a separate Vitest config that includes only `test/live/*.live.ts`; it reads `OPENAI_API_KEY` from the environment, checks the two fixtures against `test/fixtures/openai-*.json`, exits non-zero with a message when the key is missing, and never prints the key.

**Manual test checklist** (run by the owner in Brave with the extension loaded via `brave://extensions` > Developer mode > Load unpacked):
1. Right-click an image on a normal site: menu item appears; non-image elements do not show it.
2. Works in a tab that was already open before the extension was installed or reloaded.
3. Works for an image inside a same-origin and a cross-origin iframe (badge appears in the right frame).
4. Checking a second image on the same page works (injection is idempotent, no duplicate UI).
5. Image from a different origin (CDN): host permission prompt appears once and the fetch works; declining shows a clear message.
6. Restricted page (for example the Web Store): result appears in the extension window.
7. Brave Shields on and off: note any difference in image fetching.
8. Dark mode and light mode pages: popup and badge stay readable.
9. No key set: OpenAI button disabled with an explanation. Wrong key: clear 401 message. Rate limit: shows retry time.
10. OpenAI upload always opens the confirmation window; Cancel uploads nothing.
11. AVIF image from a CDN: OpenAI check uses the server-converted version and the popup says so.
12. Halloween re-saved JPEG: local checks find nothing; the OpenAI check finds SynthID and shows TÄ.

---

## 9. Milestones

**M0. Scaffold and spike**
- Repo, TypeScript, build, manifest, empty service worker, message and storage types from section 3, i18n wrapper, loads in Brave without errors.
- Spike (throwaway code written by the implementer, measurements run by the owner in Brave, results written into this plan):
  1. `@contentauth/c2pa-wasm` in the service worker: loads with `'wasm-unsafe-eval'` and lazy init, parses the halloween fixture with remote fetches disabled, no top-level `await` in the built worker, cold-start and parse time. If it fails, try the offscreen document. Record the exact loader code and build config.
  2. Messaging: confirm a 60 MiB base64 string arrives via `tabs.sendMessage` reply.
  3. `chrome.permissions.request` inside `contextMenus.onClicked`: allowed or not. Does `permissions.contains` report the `activeTab` grant?
  4. Injection into a cross-origin iframe's `frameId` with only `activeTab`: works or fails.
  5. Worker survival: a 40 MiB download and a 40 MiB upload over a throttled connection (DevTools network throttling) taking over 30 s: does the worker survive? Does `setAccessLevel` work on `storage.local`?
- Accept: extension loads; `npm run build` and `npm test` run; the spike results are recorded in section 2 and the plan is adjusted.

**M1. Context menu and UI shell**
- Menu on images; on-demand injection into the clicked frame; idempotent guard; Shadow DOM host; popup with placeholder text; fake "TÄ" badge on matching images; extension-window fallback for restricted frames.
- Accept: right-click image shows TÄ badge and popup on a normal website, including in an iframe and in a tab opened before install.

**M2. Fetch and sniff**
- Host permission flow, `fetchImage` with timeout and streaming size limit, magic-byte sniff, SHA-256, `data:`/`blob:` handling.
- Accept: type and size correctly reported for the fixtures and a cross-origin CDN image.

**M3. Local checks and verdict**
- C2PA mapping, XMP scanner, verdict, session cache, and the orchestration that runs them and sends the result.
- Accept: halloween fixture shows TÄ from local checks with claimed issuer OpenAI; phone photo shows "No AI signal found".

**M4. Options and OpenAI check**
- Options page, OpenAI request/response/error handling, confirmation window, OpenAI flow (re-fetch, hash check, server conversion), `test:live`.
- Accept: with a valid key, both fixtures give the expected results; errors display the right messages; the same image is not sent twice in a session.

**M5. Result UI**
- Final popup layout with three lines, three headlines and caveats; toasts; interrupted-check message.
- Accept: every row of the TÄ rule renders sensibly; the re-saved JPEG shows "No AI signal found" locally and TÄ after the OpenAI check.

**M6. i18n and polish**
- Finnish and English string review, tooltips, icons for the extension, error wording review, a11y (aria-labels, focus handling, contrast).
- Accept: switching browser language to Finnish shows Finnish UI everywhere.

**M7. Packaging**
- Production build, README (install from zip via Load unpacked, usage, privacy, limits: overlay images, hotlink-protected images, `file://` images need "Allow access to file URLs", compressed PNG XMP not read, OpenAI detects only OpenAI signals), version 0.1.0 zip. No store listing.
- Accept: fresh-profile install works from the zip.

---

## 10. Open questions to resolve during implementation

1. M0 spike results (section 9, M0).
2. Exact pricing and default rate limits of the Content Provenance API (check the OpenAI pricing page; not stated in the guide). Update the confirmation and test-key text accordingly.
3. Does the OpenAI SynthID check also detect Google/other partner watermarks via this API? The docs only promise "supported OpenAI signals", so assume no and say so in the UI.
4. Final Finnish label from the EU Code of Practice icon annex.
5. Whether to bundle a C2PA trust list in a later version, so local results can show `trusted` and the issuer is verified.
6. Whether to publish to a store at all (v0.1 is a zip only).
7. Whether to add other providers' checks later (only if an official public API appears).

---

## 11. Result wording (for consistency)

- Found: "AI signal found" / "Tekoälyn merkki löytyi"
- Not found: "No AI signal found. This does not prove the image is human-made." / "Tekoälyn merkkiä ei löytynyt. Se ei todista, että kuva on ihmisen tekemä."
- Incomplete: "Check incomplete" / "Tarkistus jäi kesken"
- Never use "real", "fake", "verified human" or "verified authentic".
