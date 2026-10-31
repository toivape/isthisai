# Review instructions for Copilot

This repo is a Manifest V3 browser extension (TypeScript) that checks one image, on user request, for AI-provenance signals. `AGENTS.md` (= `CLAUDE.md`) has the hard rules and `PLAN.md` the design. Each PR implements one GitHub issue; check the PR against that issue's scope and acceptance criteria.

Flag these first, as blocking:
- The image is re-encoded (canvas, `toDataURL`, `createImageBitmap`, resizing) before analysis or upload.
- The OpenAI API key is logged, put in a URL, sent to a content script or confirmation page, or read anywhere except the service worker.
- `Content-Type` is set by hand on the OpenAI multipart request, or the media type is `image/jpg` or comes from a header or file extension instead of magic bytes.
- An OpenAI upload can start without the extension confirmation window (`src/confirm/`), or a button in injected page UI acts on events where `isTrusted` is false.
- c2pa-wasm is called without `remote_manifest_fetch: false` and `ocsp_fetch: false`.
- Any network request other than fetching the chosen image or the confirmed OpenAI call; anything that runs before the user's context-menu click.
- User-visible text that says "real", "fake", "authentic" or "verified human", or omits the caveat that no signal does not prove the image is human-made. Hardcoded UI strings instead of i18n.
- An error status (400, 401, 404, 429 with `Retry-After`, 5xx, network) not mapped to a typed error.
- A test removed or weakened, or an allowed exception added to `test/rules.test.ts` without a reason.

Then check:
- Logic has unit tests that would fail if the behaviour regressed; tests do not call the network.
- Messages and storage shapes come from `src/shared/types.ts` and match `PLAN.md` §3.
- No new npm dependency or manifest permission unless the issue names it.
- The PR lists manual checks for the owner and does not claim to have run them.

Skip style nitpicks that the existing code does not follow either.
