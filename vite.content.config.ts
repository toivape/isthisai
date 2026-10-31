import { resolve } from "node:path";
import { defineConfig } from "vite";

// The content script must be one self-contained classic script (IIFE):
// chrome.scripting.executeScript cannot inject ES modules, and a shared
// chunk would be an import the injected file cannot resolve.
export default defineConfig({
  publicDir: false,
  build: {
    target: "esnext",
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: resolve("src/content/index.ts"),
      formats: ["iife"],
      name: "isthisaiContent",
      fileName: () => "content/index.js",
    },
  },
});
