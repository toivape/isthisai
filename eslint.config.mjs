import tseslint from "typescript-eslint";

// typescript-eslint 8 loads the TypeScript 6 JS API (TypeScript 7.0 ships no
// JS API); package.json aliases make import("typescript") resolve to the 6.x
// shim while the `tsc` binary stays on 7. See the TS 7.0 side-by-side notes.
export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", ".scratch/**", "reports/**", ".stryker-tmp/**"] },
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Test doubles are async without awaiting and reach into untyped fixture
    // objects on purpose; these type-aware rules only fight the fakes.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    // Plain .mjs outside tsconfig (which has no allowJs): no type information.
    files: ["scripts/**/*.mjs", "eslint.config.mjs", "stryker.config.mjs", "stryker.pr.config.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
);
