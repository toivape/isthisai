import { build } from "vite";

// Two configs share dist/: the main build (which empties dist/) must finish
// before the content build writes into it. Watch mode never re-empties, so
// after the one-shot builds the watchers can run side by side in one process.
await build({ configFile: "vite.config.ts" });
await build({ configFile: "vite.content.config.ts" });
await Promise.all([
  build({ configFile: "vite.config.ts", build: { watch: true, emptyOutDir: false } }),
  build({ configFile: "vite.content.config.ts", build: { watch: true } }),
]);
