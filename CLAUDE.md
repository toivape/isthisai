# CLAUDE.md

Browser extension (Manifest V3, TypeScript) for Brave/Chromium. On user request, it checks one image for AI-provenance signals and marks it with a **TÄ** badge. Full plan, milestones and acceptance criteria are in `PLAN.md`. Read it before starting work and follow its milestone order.

## Commands
Update this list after M0 if the scripts change.
- `npm install` : install dependencies
- `npm run dev` : watch build into `dist/`
- `npm run build` : production build into `dist/`
- `npm run typecheck` : `tsc --noEmit`
- `npm test` : Vitest unit tests (all network mocked)
- `npm run test:live` : opt-in; reads `OPENAI_API_KEY` from the environment and checks the fixtures in `test/fixtures/`

Load the extension manually: `brave://extensions` > Developer mode > Load unpacked > select `dist/`.

## Architecture (summary)
- `src/background/` : service worker. Fetches image bytes, runs local checks (C2PA, XMP/IPTC), calls the OpenAI API, caches results. Only place that reads the API key.
- `src/content/` : content script, injected by the worker only after a menu click (not declared in the manifest). UI only (TÄ badge, popup), all inside a Shadow DOM. No network calls except reading `blob:` image URLs, no key access.
- `src/confirm/` : extension window for the OpenAI upload confirmation, and for results when the page cannot be injected.
- `src/options/` : options page (write-only API key, test-key button, privacy text).
- `src/shared/` : types and i18n helpers shared by all of the above.
- Worker and content script talk through typed messages defined in `src/shared/types.ts`. Add new message types there first.

## Hard rules (do not break these)
1. **Never scan pages automatically.** Checks run only after the user picks the context-menu item on an image. Nothing is injected into a page before that.
2. **Never re-encode the image** (no canvas, no resizing) before analysis or upload. Always use the original bytes. Re-encoding destroys the metadata and the watermark.
3. **The OpenAI API key** lives only in `chrome.storage.local` (access level `TRUSTED_CONTEXTS`), is read only in the service worker (the options page writes it but never reads it back), and is never logged, put in URLs, sent to content scripts, committed to the repo or printed in output. No hardcoded keys, no sample keys in tests.
4. **Never set the `Content-Type` header manually** on the multipart upload to OpenAI. Use `FormData` and set the file part's real media type (`image/jpeg`, not `image/jpg`). Detect the type from magic bytes, not from headers or file extensions.
5. **Ask the user before every OpenAI upload**, in the extension confirmation window, never in UI injected into the page (page scripts can restyle or hide it). No "don't ask again". Local checks never leave the machine.
6. **synthid.com is out of scope** (no public API). Do not automate it, link to it or scrape it.
7. **No remote code, no analytics, no tracking, no extra network requests** beyond fetching the chosen image and the confirmed OpenAI call. Always call c2pa-wasm with `remote_manifest_fetch` and `ocsp_fetch` disabled; otherwise a crafted image makes it fetch an attacker's URL.
8. **Wording:** results are "AI signal found" / "No AI signal found". Never write "real", "fake", "verified human" or "authentic". Always include the caveat that no signal does not prove the image is human-made.
9. A C2PA manifest from a non-AI source (for example a camera) is **not** an AI signal. Show TÄ only when an AI-generation signal is detected (see verdict rule in `PLAN.md`).

## Code conventions
- TypeScript `strict: true`. No `any` unless commented why. Prefer `unknown` plus narrowing.
- Small pure functions for sniffing, verdict merging and response parsing, so they are unit-testable without the browser.
- Handle every API outcome explicitly: 200, 400, 401, 404, 429 (honour `Retry-After`), network failure. Return typed errors, do not throw strings.
- Async code: no unhandled promises; the MV3 service worker can be stopped at any time, so keep no important state in module variables (use `chrome.storage.session` or `chrome.storage.local`).
- All user-visible text goes through i18n (`_locales/en`, `_locales/fi`). No hardcoded UI strings. The badge text **TÄ** is a literal in both locales.
- Injected UI must not inherit or leak page styles (Shadow DOM, no global CSS, no changes to the page's DOM beyond one host element).
- Keep dependencies minimal. Ask before adding a new npm dependency or a new manifest permission, and say why it is needed.

## Development method: TDD
This project is built test-first. For every piece of logic:
1. **Red:** write a failing test that describes the behaviour. Run it and confirm it fails for the right reason before writing any implementation.
2. **Green:** write the smallest implementation that makes the test pass.
3. **Refactor:** clean up with the tests green. Run the full suite after each refactor.

Rules:
- No production code for testable logic without a failing test first. Keep red/green/refactor steps small (one behaviour at a time) and commit in those small steps when asked to commit.
- Design for testability: put logic in pure functions (magic-byte sniffing, verdict merging, OpenAI response parsing, error mapping, cache keys, message handling) and keep browser-API calls (`chrome.*`, DOM) in thin wrappers. Keep test setup simple; a tiny hand-written fake is fine, a large `chrome` emulation is not.
- Cover the error and edge cases with tests too: every API status (400, 401, 404, 429 with `Retry-After`), network failure, unsupported or oversized files, invalid or missing C2PA manifests, non-AI C2PA manifests.
- **Be pragmatic: skip TDD where it isn't practical.** If a test would need elaborate mocks, fragile browser-API emulation or a lot of setup compared with the code it covers, do not write it. Manual testing in Brave is acceptable and preferred over complicated test machinery. This usually applies to the context menu, on-demand script injection, Shadow DOM rendering, permission prompts, the service worker lifecycle and anything that depends on real pages or real browser behaviour.
- When you skip a test for that reason, add the behaviour to the manual checklist in `PLAN.md` (one line) and mention it in the milestone summary. Do not skip silently, and do not skip simple pure logic: sniffing, verdict merging, response parsing, error mapping and cache keys should still be test-first.
- Never weaken or delete a test to make it pass. If a test is wrong, explain why and fix the test deliberately.
- When fixing a bug, first write a test that reproduces it.
- At the start of each milestone, list the tests you plan to write (names only) so the user can review the behaviour before implementation starts.

## Testing
- Fixtures live in `test/fixtures/`: `ai-test-halloween.png` (ChatGPT image; expect OpenAI c2pa and synthid both detected) and `ai-tes-iceland.jpg` (phone photo; expect none).
- Use the real OpenAI API responses in `test/fixtures/openai-*.json` as parser fixtures.
- Unit tests must not call the network. Live checks only via `npm run test:live`.
- After each milestone: run `npm run typecheck`, `npm test` and `npm run build`, then list the manual checks from `PLAN.md` that the user should run in Brave.
- You cannot run Brave. Never report a manual check or a spike measurement as done, and never invent measured values: list them for the owner to run.

## Working style
- Work test-first (see "Development method: TDD").
- Do one milestone at a time. Stop at the end of the milestone, summarise what changed in a few lines, and say how to test it. Do not start the next milestone without being asked.
- If something in `PLAN.md` turns out to be wrong or impossible (for example c2pa-wasm not running in the service worker), do not silently work around it: explain the problem and propose the change, then update `PLAN.md` once agreed.
- Do not commit secrets or `dist/`. Check `.gitignore` covers `node_modules/`, `dist/`, `.env*`.
