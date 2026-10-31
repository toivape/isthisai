import { defineConfig } from "vitest/config";

// Live tests hit the real OpenAI API and must never run under `npm test`
// (vite.config.ts excludes test/live/**). ISTHISAI_LIVE marks that this
// config, and only this config, picked the files up.
export default defineConfig({
  test: {
    include: ["test/live/*.live.ts"],
    env: { ISTHISAI_LIVE: "1" },
  },
});
