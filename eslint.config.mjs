import { realpathSync } from "node:fs";
import { createRequire } from "node:module";

// pre-commit installs ESLint and these packages side by side in its own Node env, not in a
// node_modules here, so resolve them from the running ESLint rather than from this file.
const require = createRequire(realpathSync(process.argv[1]));
const js = require("@eslint/js");
const globals = require("globals");

export default [
  js.configs.recommended,
  {
    rules: { "no-empty": ["error", { allowEmptyCatch: true }] },
  },
  {
    files: ["eslint.config.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["static/**/*.js"],
    languageOptions: { globals: globals.browser },
  },
  {
    // Classic scripts: theme.js loads in <head>, parser-worker.js is a non-module Worker.
    files: ["static/theme.js", "static/parser-worker.js"],
    languageOptions: { sourceType: "script" },
  },
  {
    files: ["static/parser-worker.js"],
    languageOptions: { globals: globals.worker },
  },
];
