import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vite.config";

// Stryker runs the test suite instrumented, which is several times slower than
// a plain `npm test`. The multi-MiB data-URL tests in test/fetchImage.test.ts
// then blow vitest's 5 s default on a 2-core CI runner and the dry run aborts
// with "There were failed tests in the initial test run". Raise the per-test
// timeout for mutation runs only; `npm test` keeps the default.
export default mergeConfig(base, defineConfig({ test: { testTimeout: 30_000 } }));
