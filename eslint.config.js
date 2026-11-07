// Structural gates. The numbers are a ratchet: measured on 2026-11-06 at the
// current ceiling, to be lowered as agents refactor, never raised to let a
// change through. See HARNESS.md.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules", "dist", "dist-test", ".wrangler", "worker-configuration.d.ts", "coverage", "reports", ".stryker-tmp", "public"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      // --- size and shape -------------------------------------------------
      complexity: ["error", { max: 15 }],
      "max-lines": ["error", { max: 260, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 60, skipBlankLines: true, skipComments: true }],
      "max-statements": ["error", { max: 30 }],
      "max-depth": ["error", { max: 4 }],
      "max-params": ["error", { max: 5 }],
      "max-nested-callbacks": ["error", { max: 3 }],
      // --- things an agent reaches for when it is stuck ---------------------
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "off", // `body.body!` after a check is idiomatic here
      "no-constant-condition": ["error", { checkLoops: false }], // `for (;;)` paging loops are deliberate
      "no-empty": ["error", { allowEmptyCatch: true }], // `catch {}` with a comment is a decision, keep it readable
      "no-console": "off", // console.log *is* the logger on Workers; log.ts owns it
    },
  },
  {
    files: ["scripts/**/*.mjs", "features/**/*.mjs", "*.config.js", "*.config.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
  },
  {
    files: ["test/**/*.ts", "scripts/**/*.mjs", "features/**/*.mjs", "*.config.ts", "*.config.js", "*.config.mjs"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
);
