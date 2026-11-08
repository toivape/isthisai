import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";
import type { Plugin } from "vite";

// Files the bundler itself never reads; the copy happens in closeBundle, so
// they must be registered with the watcher explicitly or dev mode goes stale.
const NON_BUNDLED_FILES = [
  resolve("manifest.json"),
  ...readdirSync("_locales").flatMap((localeDir) =>
    readdirSync(join("_locales", localeDir)).map((file) => resolve("_locales", localeDir, file)),
  ),
];

function copyExtensionFiles(): Plugin {
  return {
    name: "copy-extension-files",
    buildStart() {
      for (const file of NON_BUNDLED_FILES) {
        this.addWatchFile(file);
      }
    },
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
