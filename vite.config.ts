import { cpSync, mkdirSync } from "node:fs";
import { configDefaults, defineConfig } from "vitest/config";
import type { Plugin } from "vite";

function copyExtensionFiles(): Plugin {
  return {
    name: "copy-extension-files",
    closeBundle() {
      mkdirSync("dist/_locales", { recursive: true });
      cpSync("manifest.json", "dist/manifest.json");
      cpSync("_locales", "dist/_locales", { recursive: true });
    },
  };
}

// The content script is built separately (vite.content.config.ts) because
// chrome.scripting.executeScript injects plain files, not ES modules.
export default defineConfig({
  publicDir: false,
  plugins: [copyExtensionFiles()],
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        background: "src/background/index.ts",
        options: "src/options/options.html",
        confirm: "src/confirm/confirm.html",
      },
      output: {
        // manifest.json points at a fixed filename; the HTML entries can
        // keep hashed assets because the built HTML references them.
        entryFileNames: (chunk) =>
          chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
      },
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "test/live/**"],
  },
});
