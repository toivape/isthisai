# Is this AI?

A Manifest V3 browser extension for Brave/Chromium. On request (right-click an image → context menu), it checks the image for AI-provenance signals — Content Credentials (C2PA), XMP metadata, and (via a confirmed OpenAI API call) SynthID — and marks AI-generated images with a **TÄ** badge.

Nothing is scanned automatically; every check starts from a user action. The full design, milestones and hard rules live in [PLAN.md](PLAN.md).

## Setup

Requires Node.js 24 (LTS) and npm.

```sh
npm install
```

## Everyday commands

```sh
npm run dev        # watch build into dist/ (rebuild on source, manifest and locale changes)
npm run build      # production build into dist/
npm run typecheck  # tsc --noEmit
npm test           # Vitest unit tests (no network; test/live/ excluded)
npm run test:live  # opt-in: hits the real OpenAI API, reads OPENAI_API_KEY from the environment
```

CI runs `typecheck`, `test` and `build` on every pull request and on pushes to `main`.

## Mutation testing

`npm run test:mutation` runs [Stryker](https://stryker-mutator.io) over the unit-tested
pure logic (`src/background/`, the unit-tested modules under `src/content/`, and the
shared types/helpers) to check that the tests actually detect faults, not just execute
lines. The injectable/MV3 surfaces (`src/content/index.ts`, `src/content/readBlob.ts`,
`src/confirm/`, `src/options/`, the chrome wiring in `src/background/index.ts`) are
covered by the manual checklist in `PLAN.md` §8 instead. It writes an HTML report to
`reports/mutation/mutation.html` (git-ignored) and exits non-zero if the mutation score
drops below the `break` threshold (90%; see `stryker.config.mjs`).

It is not part of the PR/push pipeline (`ci.yml`). Run it locally, or start the
**Mutation testing** workflow by hand from the GitHub Actions tab (pick a branch in the
"Run workflow" dropdown); that job uploads the report as a `mutation-report` artifact.

## Load in Brave

1. `npm run build`
2. `brave://extensions` → enable **Developer mode** → **Load unpacked** → select `dist/`

## Project layout

```
src/background/   service worker: fetches bytes, local checks (C2PA, XMP), OpenAI call, cache
src/content/      injected UI (TÄ badge, popup) inside a Shadow DOM — injected only after a menu click
src/confirm/      extension window: OpenAI upload confirmation, fallback result view
src/options/      options page (write-only API key)
src/shared/       types and i18n helpers
test/             unit tests, hard-rule scanners and fixtures
```
