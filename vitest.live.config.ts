import { defineConfig } from "vitest/config";

// Live tests hit the real OpenAI API and must never run under `npm test`
// (vite.config.ts excludes test/live/**). ISTHISAI_LIVE marks that this
// config, and only this config, picked the files up.
export default defineConfig({
  test: {
    include: ["test/live/*.live.ts"],
    env: { ISTHISAI_LIVE: "1" },
    // The client allows one upload up to FETCH_DEADLINE_MS (25 s). Vitest's 5 s
    // default would fail a legitimately slow response before the client judged
    // it, and would leave that upload running into the next test.
    testTimeout: 30_000,
  },
});
