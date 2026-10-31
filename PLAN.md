# Browser extension: on-demand AI image check ("TÄ" badge)

Plan for a Manifest V3 extension for Brave (works in any Chromium browser). The user right-clicks an image and picks a menu item to check whether it carries AI-provenance signals. If it does, the image is marked with the text **TÄ** (tekoäly).

Work through the milestones in order. Each has acceptance criteria; do not start the next milestone until they pass.

**Method: pragmatic TDD.** Logic that is easy to test (sniffing, verdict merging, API parsing, error mapping, caching, C2PA parsing) is built test-first (red, green, refactor), as described in `CLAUDE.md`. Where TDD is impractical (browser UI, context menu, permissions, service worker behaviour), skip it and rely on manual testing in Brave instead of writing complicated test code; add those items to the manual checklist in section 8. At the start of each milestone, list the planned tests by name for review.

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
- No ML "looks AI" classifier. Only provenance signals (C2PA, metadata, SynthID via OpenAI API).
- No claim that an unmarked image is human-made. Wording is always "no AI signal found".
- No synthid.com integration of any kind (no public API; its terms prohibit automation).

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
  - Errors: 400 bad/unsupported file, 401 bad key, 404 org without access, 429 rate limit (honour `Retry-After`).
  - Rate limits are described as strict (no numbers published). **Pricing is not stated in the guide: check https://developers.openai.com/api/docs/pricing and tell users the check may be billed.**
- Re-encoding the image (for example drawing it on a canvas) destroys both metadata and watermark. **Always send/inspect the original bytes.**
- C2PA metadata is often stripped by CDNs, screenshots and re-saves. SynthID lives in the pixels and survives more edits. Either signal is enough to show TÄ.
- Verified OpenAI API results from the project owner's own key:
  - `ai-test-halloween.png` (original ChatGPT image): `c2pa` detected (trusted, issuer "OpenAI OpCo, LLC", model "ChatGPT / gpt-image") and `synthid` detected.
  - `ai-tes-iceland.jpg` (phone photo): both `not_detected`, c2pa `validation_state: "not_present"`.
- **Local C2PA library, verified 2026-10-31:**
  - The `c2pa` npm package is deprecated in favour of `@contentauth/c2pa-web`.
  - `@contentauth/c2pa-web` always spawns a Web Worker (`new Worker(...)`; a custom `workerSrc` must be `https:`). Service workers have no `Worker`, so it cannot be used in the service worker.
  - Its lower-level dependency `@contentauth/c2pa-wasm` (0.13.x) exposes `WasmReader.fromBytes(format, Uint8Array)`, which uses no browser-only APIs. Run in Node against the fixtures:
    - `ai-test-halloween.png`: parsed in ~50 ms. Issuer "OpenAI OpCo, LLC". Active manifest action `c2pa.created` with `softwareAgent` ChatGPT / gpt-image and `digitalSourceType` `http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia`, plus `c2pa.watermarked.unbound`. `validation_state: "Valid"` (not `Trusted`: `signingCredential.untrusted`, because no trust anchors are configured).
    - `ai-tes-iceland.jpg`: throws `C2pa(JumbfNotFound)`. This means "no manifest" and maps to `not_detected`, not to an error.
  - The `.wasm` is about 9 MB.

---

## 3. Architecture

```
┌──────────────┐  context-menu click (srcUrl, frameId)
│ Context menu │ ───────────────────────────────────▶ ┌─────────────────────┐
└──────────────┘                                      │ Service worker      │
┌──────────────┐  injected on demand into that frame  │ (background)        │
│ Content      │ ◀─────────────────────────────────── │ - fetch image bytes │
│ script (UI)  │   result messages                    │ - local checks      │
│ - TÄ badge   │ ───────────────────────────────────▶ │ - OpenAI API call   │
│ - popup      │   user actions (OpenAI check, blob)  │ - cache             │
└──────────────┘                                      └─────────────────────┘
        Options page: API key, settings, privacy text
```

- **Service worker** does everything that needs the network or heavy parsing. The API key is only ever read here and never sent to page scripts.
- **Content script** is not declared in the manifest. The worker injects it with `chrome.scripting.executeScript` into `info.frameId` only after a menu click (`activeTab` grants access to that tab). Injection must be idempotent (a global "already loaded" guard), because the user may check several images on the same page.
- The content script only handles UI on the page. Put all injected UI in a **closed Shadow DOM** so page CSS cannot break it and page scripts cannot easily reach it.
- **Messaging is JSON-only** (`runtime.sendMessage` / `tabs.sendMessage` require JSON-serialisable messages; an `ArrayBuffer` does not survive). Never put raw binary in a message.
- **`data:` URLs:** the worker fetches them directly.
- **`blob:` URLs:** only the page can read them. The content script fetches the blob and sends it to the worker base64-encoded. Cap this path at 45 MiB (base64 adds a third; stay under Chrome's message size limit). Confirm the limit in the M0 spike.

### Tech choices
- TypeScript, Vite (or esbuild) multi-entry build, Vitest for unit tests.
- `@contentauth/c2pa-wasm` for Content Credentials, called via `WasmReader.fromBytes` directly in the service worker. Needs `'wasm-unsafe-eval'` in the extension CSP and the `.wasm` bundled in the extension, loaded from `chrome.runtime.getURL(...)`. If the M0 spike shows it cannot run in the worker, fall back to an offscreen document (`chrome.offscreen`) and add the `offscreen` permission.
- No C2PA trust list in v0.1 (bundling one goes stale; downloading one breaks the no-extra-requests rule). `Valid` and `Trusted` are both accepted; see the TÄ rule.
- `exifr` for XMP/IPTC parsing (enable XMP parsing explicitly).
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
│  │  ├─ index.ts            # menu registration, injection, message router
│  │  ├─ fetchImage.ts       # download bytes, timeout, streaming size limit
│  │  ├─ sniff.ts            # magic-byte media type detection
│  │  ├─ localChecks.ts      # C2PA + XMP/IPTC checks
│  │  ├─ openaiCheck.ts      # API call + response parsing + error mapping
│  │  ├─ verdict.ts          # combine signals -> result model
│  │  └─ cache.ts            # result cache keyed by SHA-256 of bytes
│  ├─ content/
│  │  ├─ index.ts            # injected entry, idempotent guard, find <img> for a URL
│  │  ├─ badge.ts            # TÄ badge overlay
│  │  └─ popup.ts            # result popup, toasts, OpenAI confirmation (Shadow DOM)
│  ├─ options/
│  │  ├─ options.html
│  │  └─ options.ts
│  └─ shared/
│     ├─ types.ts            # CheckResult, Signal, messages
│     └─ i18n.ts
└─ test/
   ├─ fixtures/              # see section 8
   └─ *.test.ts
```

### Manifest outline (MV3)
- `permissions`: `contextMenus`, `storage`, `activeTab`, `scripting` (add `offscreen` only if the C2PA spike needs it).
- `host_permissions`: `https://api.openai.com/*`.
- `optional_host_permissions: ["<all_urls>"]`, requested once at first use ("Allow the extension to download images you check"). Needed because `activeTab` covers only the page's own origin, and most images are served from another origin (CDN).
- No `content_scripts` entry.
- `content_security_policy.extension_pages`: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.
- `background.service_worker` (type module), `options_ui`.
- `default_locale: "en"`, `name`/`description` via `__MSG_...__`.
- `minimum_chrome_version`: set in M0 to the Chromium version of the current Brave release.

---

## 4. Check pipeline (service worker)

Triggered only by a context-menu click. Input: `info.srcUrl`, `tab.id`, `info.frameId`.

1. **Host permission.** If the image origin is not covered (`chrome.permissions.contains`), request `<all_urls>`. Whether `permissions.request` is allowed inside `contextMenus.onClicked` is checked in the M0 spike; if it is not, open a small extension page with an "Allow" button that makes the request. If the user declines: error `permission_denied`.
2. **Inject the UI script** into the frame and show the "checking" state.
3. **Fetch bytes.** `fetch(url, {credentials: "omit", headers: {Accept: ...}, signal: AbortSignal.timeout(...)})`. Set `Accept` to the value Brave sends for `<img>` requests (copy it from DevTools in M2), so a CDN that negotiates formats returns the same bytes the page displays. Stop reading once more than 50 MiB has arrived (do not download everything and then check). `blob:` bytes come from the content script instead (see section 3). Sniff the media type from magic bytes (do not trust the `Content-Type` header or file extension). Compute SHA-256 of the bytes. Some sites will refuse the download (hotlink protection, login-only images); report `fetch_failed` with the "the site blocked the download" hint.
4. **Cache lookup** by SHA-256. If a result exists (and the OpenAI step was already done, or not requested), return it.
5. **Local checks** (free, offline, nothing leaves the machine). Run for every supported image type, including AVIF/HEIC/GIF if the parsers accept them; only the OpenAI step is limited to PNG/JPEG/WebP.
   - C2PA manifest: `WasmReader.fromBytes`. `JumbfNotFound` means `not_detected`; other parser errors mean `error`. Record issuer, validation state, generator/model, time, and whether any manifest in the store has an action whose `digitalSourceType` is AI (see TÄ rule).
   - XMP/IPTC: `Iptc4xmpExt:DigitalSourceType` (match on the IPTC URI ending), plus generator names in software/creator-tool fields as a weak hint (shown as "possible", does not by itself trigger TÄ).
6. **Verdict from local checks.** If a local AI signal is found, show TÄ immediately; the OpenAI check is still offered but not needed.
7. **If no local AI signal:** show "No AI signal found in the file's metadata" with the button **Check watermark with OpenAI** (enabled only if an API key is configured and the image type is PNG/JPEG/WebP).
8. **OpenAI check** (only after the user clicks, with the confirmation from section 6). The worker may have been stopped since step 3, so nothing is kept in memory: the request carries the image URL again (or the base64 bytes again for `blob:`), the worker fetches again and checks that the SHA-256 matches the cached result before uploading (`hash_mismatch` otherwise). Send the original bytes. Parse the response. Merge into the result. Cache by SHA-256.

### Cache
- `chrome.storage.session` (cleared when the browser closes; image hashes are not kept as long-term history).
- Store only results, never image bytes.
- Never cache errors, so a retry after 429 or a network failure really retries.
- No "check again" in v0.1: a cached result is shown as is.

### Verdict model (`CheckResult`)
```ts
type SignalState = "detected" | "not_detected" | "not_checked" | "error";

interface CheckResult {
  imageHash: string;
  aiSignal: boolean;                 // true => show TÄ
  signals: {
    localC2pa:   { state: SignalState; issuer?: string; validation?: "valid" | "trusted" | "invalid"; model?: string; generatedAt?: string; aiAction?: boolean };
    localMeta:   { state: SignalState; digitalSourceType?: string; generatorHint?: string };
    openaiC2pa:  { state: SignalState; issuer?: string; validation?: string; model?: string; generatedAt?: string };
    openaiSynthId: { state: SignalState; model?: string; generatedAt?: string };
  };
  error?: {
    code: "unsupported_type" | "too_large" | "fetch_failed" | "timeout" | "permission_denied" | "hash_mismatch"
        | "no_key" | "http_400" | "http_401" | "http_404" | "http_5xx" | "rate_limited" | "network";
    retryAfterSec?: number;
  };
}
```

### TÄ rule
`aiSignal = true` if any of these is `detected`:
- **Local C2PA:** validation state `Valid` or `Trusted`, and any manifest in the store (active manifest or ingredient) has an action whose `digitalSourceType` ends in `trainedAlgorithmicMedia` or `compositeWithTrainedAlgorithmicMedia`.
- **Local metadata:** XMP/IPTC `DigitalSourceType` ending in one of the same two values. The popup labels it as unsigned metadata.
- **OpenAI C2PA** `detected`.
- **OpenAI SynthID** `detected`.

Not an AI signal (show details in the popup, no TÄ):
- A C2PA manifest from a non-AI source (for example a camera).
- A C2PA manifest with AI actions but `Invalid` validation (shown as "manifest present but invalid").
- `algorithmicMedia` and `compositeSynthetic` (not machine-learning generated by IPTC definition).
- Generator-name hints in software fields.

---

## 5. UI behaviour

**Trigger:** one context menu item on images: title "Check for AI signals" / "Tarkista tekoälyn merkit". Uses `contexts: ["image"]`; click info gives `srcUrl` and `frameId`.

**Known limitation:** on sites that lay a transparent element over images (for example Instagram, Pinterest), the right-click hits that element, so the browser does not offer the image menu item. Workaround for users: open the image in its own tab and right-click it there. State this in the README.

**States shown on the image**
- Checking: small spinner over the image corner.
- AI signal found: **TÄ** badge over the image corner (tooltip "Tekoäly" / "AI signal found (tekoäly)"); clicking it opens the popup.
- No signal: no badge. A brief toast "No AI signal found. This does not prove the image is human-made." and the popup with the OpenAI button from pipeline step 7.
- Error: toast with a short message and retry hint.

**Popup content** (Shadow DOM, closes on Esc / outside click)
- Headline: "AI signal found" or "No AI signal found".
- Two labelled lines: "Content Credentials (C2PA)" and "Watermark (SynthID)", each with the state and details (issuer, model, time).
- Always show the caveat line: "No signal does not mean the image is human-made."
- OpenAI button as in pipeline step 7.

**Page scripts must not be able to trigger uploads.** Every button handler in the injected UI (OpenAI check, confirmation) ignores events where `event.isTrusted` is false.

**Finding the element for a URL:** the content script is injected after the click, so it cannot know which element was right-clicked. It looks in its frame for `<img>` elements whose `currentSrc` or `src` matches `srcUrl` and badges all of them. If none match (CSS background images, `<picture>` edge cases), show the popup in a fixed corner of the viewport and skip the badge.

**Badge persistence:** keep badges only for the life of the page (a `WeakMap` of element to result inside the injected script). Do not store browsing history.

---

## 6. API key, privacy and safety

- Options page field for the OpenAI API key (password-type input, "Test key" button that runs a check on a tiny built-in sample and reports success/401/404 without exposing the key). The options text says that the test is a real check and may be billed.
- Store in `chrome.storage.local` (not `sync`). Read only in the service worker. Never log it, never put it in URLs, never send it to content scripts.
- Advise users in the options text to create a **dedicated project key with a spend limit** in the OpenAI dashboard.
- **Confirmation before every OpenAI upload** (checkbox "Don't ask again" stored in settings): "This image will be sent to OpenAI to check for provenance signals. Checks may be billed to your OpenAI account."
- The extension makes no network requests other than: fetching the image the user chose, and the OpenAI call the user confirmed.
- Privacy section in the options page and README, stating exactly this.
- Handle `data:`/`blob:` and cross-origin fetch failures gracefully (explain that the site blocked the download).
- Never try to evade or reverse watermarks (OpenAI's usage guidance forbids repeated queries to do so). Cache by hash so the same image is not re-sent.

---

## 7. Internationalisation

- `_locales/en` and `_locales/fi`. All user-visible strings through `chrome.i18n.getMessage` (or a small wrapper for the Shadow DOM UI).
- Badge text is the literal **TÄ** in both locales. Tooltip "Tekoäly" (fi) and "AI signal found (tekoäly)" (en).
- Before release, check the final Finnish wording used in the EU Code of Practice icon annex (the EU "AI" icon is localised per language) and align the badge/tooltip if it differs.

---

## 8. Testing

**Fixtures** (`test/fixtures/`, owner supplies the real files):
- `ai-test-halloween.png`: original ChatGPT image. Expect OpenAI c2pa `detected` (trusted) and synthid `detected`. Expect local C2PA `detected` with validation `valid` (not `trusted`, no trust list) and an AI action.
- `ai-tes-iceland.jpg`: phone photo. Expect everything `not_detected`; local C2PA reports `JumbfNotFound`, OpenAI c2pa `not_present`.
- Raw OpenAI JSON responses for both fixtures (identifiers removed), saved as `test/fixtures/openai-*.json`, used as parser fixtures. **Owner to add.**
- Derived files to generate in a test script: JPEG re-save of the halloween image (metadata stripped). Expect local checks `not_detected`; OpenAI synthid likely still `detected` (manual verification, record the actual result).
- Small WebP, GIF and AVIF files for type handling. Do **not** commit a file over 50 MiB: test the size limit with a fake stream.

**Unit tests (Vitest):** magic-byte sniffing, C2PA result mapping (runs `@contentauth/c2pa-wasm` in Node against the fixtures), XMP DigitalSourceType mapping, verdict merging (every combination of signal states, plus the not-an-AI-signal cases in the TÄ rule), OpenAI response parsing, error mapping (400/401/404/429 with `Retry-After`/5xx/network), streaming size limit, cache keys.

**Mocking:** mock `fetch` for the OpenAI endpoint. No real API calls in CI. Provide an opt-in script `npm run test:live` that reads `OPENAI_API_KEY` from the environment and checks the two fixtures.

**Manual test checklist** (run in Brave with the extension loaded via `brave://extensions` > Developer mode > Load unpacked):
1. Right-click an image on a normal site: menu item appears; non-image elements do not show it.
2. Works in a tab that was already open before the extension was installed or reloaded.
3. Works for an image inside an iframe (badge appears in the right frame).
4. Checking a second image on the same page works (injection is idempotent, no duplicate UI).
5. Image from a different origin (CDN): host permission prompt appears once and the fetch works; declining shows a clear message.
6. Brave Shields on and off: note any difference in image fetching.
7. Dark mode and light mode pages: popup and badge stay readable.
8. No key set: OpenAI button disabled with an explanation. Wrong key: clear 401 message. Rate limit: shows retry time.

---

## 9. Milestones

**M0. Scaffold and spike**
- Repo, TypeScript, build, manifest, empty service worker, loads in Brave without errors.
- Spike (throwaway code, results written into this plan):
  1. `@contentauth/c2pa-wasm` in the service worker: loads with `'wasm-unsafe-eval'`, parses the halloween fixture, cold-start time recorded. If it fails, try the offscreen document.
  2. `runtime.sendMessage` with an `ArrayBuffer` (confirm it does not survive) and the largest base64 message that does.
  3. `chrome.permissions.request` called inside `contextMenus.onClicked`: allowed or not.
- Accept: extension loads; `npm run build` and `npm test` run; the three spike results are recorded in section 2 and the plan is adjusted.

**M1. Context menu and UI shell**
- Menu on images; on-demand injection into the clicked frame; idempotent guard; Shadow DOM host; popup with placeholder text; fake "TÄ" badge on matching images.
- Accept: right-click image shows TÄ badge and popup on a normal website, including in an iframe and in a tab opened before install.

**M2. Fetch and sniff**
- Host permission flow, `fetchImage` with timeout and streaming size limit, magic-byte sniff, SHA-256, `data:`/`blob:` handling.
- Accept: type and size correctly reported for the fixtures and a cross-origin CDN image.

**M3. Local checks**
- C2PA via `WasmReader.fromBytes` (in the worker or offscreen, per the M0 spike), XMP/IPTC DigitalSourceType.
- Accept: halloween fixture shows an AI signal locally with issuer OpenAI and validation `valid`; phone photo shows none.

**M4. Options and OpenAI check**
- Options page, key storage, test-key button, minimal "Check with OpenAI" button in the placeholder popup, confirmation dialog, re-fetch with hash check, API call, response parsing, error mapping, cache.
- Accept: with a valid key, both fixtures give the expected results; errors display the right messages; the same image is not sent twice.

**M5. Verdict and result UI**
- Verdict merging, final popup layout with two signal lines and caveat, toasts.
- Accept: all rows of the signal-state matrix render sensibly; images re-saved without metadata are handled as described in section 8.

**M6. i18n and polish**
- Finnish and English strings, tooltips, icons for the extension, error wording review, a11y (aria-labels, focus handling, contrast).
- Accept: switching browser language to Finnish shows Finnish UI everywhere.

**M7. Packaging**
- Production build, README (install from zip via Load unpacked, usage, privacy, limits including the overlay limitation), version 0.1.0 zip. No store listing.
- Accept: fresh-profile install works from the zip.

---

## 10. Open questions to resolve during implementation

1. M0 spike results (C2PA in the worker, message size limit, `permissions.request` from a menu click).
2. Exact pricing and default rate limits of the Content Provenance API (check the OpenAI pricing page; not stated in the guide). Update the confirmation text accordingly.
3. Does the OpenAI SynthID check also detect Google/other partner watermarks via this API? The docs only promise "supported OpenAI signals", so assume no and say so in the UI.
4. Final Finnish label from the EU Code of Practice icon annex.
5. Whether to bundle a C2PA trust list in a later version, so local results can show `trusted`.
6. Whether to publish to a store at all (v0.1 is a zip only).
7. Whether to add other providers' checks later (only if an official public API appears).

---

## 11. Result wording (for consistency)

- Found: "AI signal found" / "Tekoälyn merkki löytyi"
- Not found: "No AI signal found. This does not prove the image is human-made." / "Tekoälyn merkkiä ei löytynyt. Se ei todista, että kuva on ihmisen tekemä."
- Never use "real", "fake", "verified human" or "verified authentic".
