import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";
import globals from "globals";

/**
 * One flat config for the whole monorepo, so all five workspaces share the
 * same rules rather than drifting apart. Per-workspace `lint` scripts just
 * point ESLint at their own directory; the rules all come from here.
 *
 * Deliberately uses the NON type-checked typescript-eslint preset: type-aware
 * linting would need a TS program per workspace (five of them, two with
 * Expo's generated types) and turns a ~5s lint into a minute-plus in CI.
 * `tsc --noEmit` already covers the type dimension in the same pipeline.
 */

/**
 * Where console.* is allowed. Everything else is production source and must
 * log through a real logger (the server) or not at all.
 *
 *  - tests            — assertions and debugging output, never shipped.
 *  - src/scripts/**   — hand-run operator/dev scripts; their console output IS
 *                       the interface (e.g. sendTestOtpMoolre, moolreSandbox).
 *  - prisma/seed.ts   — a CLI script; progress output is the point.
 *  - src/dev/**       — the mockDriver simulator, already gated behind
 *                       ENABLE_MOCK_DRIVER and never enabled in production.
 */
const CONSOLE_ALLOWED = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/test/**",
  "apps/server/src/scripts/**",
  "apps/server/prisma/**",
  "apps/server/src/dev/**",
  // Repo-level tooling (the CI audit gate). Its console output is what a
  // developer reads in the CI log — that IS the interface.
  "scripts/**",
];

export default tseslint.config(
  {
    // Build output, dependencies and generated files are not ours to lint.
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.expo/**",
      "**/web-build/**",
      "**/*.d.ts",
      "apps/*/expo-env.d.ts",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ── Shared defaults for every workspace ────────────────────────────────────
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mjs"],
    rules: {
      // The no-console rule this phase is about. Production code logs through
      // Fastify's logger (server) or nothing at all (apps); see CONSOLE_ALLOWED
      // above for the deliberate exemptions.
      "no-console": "error",

      // An unused variable is usually a leftover or a bug. The underscore
      // escape hatch is for genuinely-unused destructured params and catches.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],

      // `any` defeats the point of the strict tsconfigs; warn rather than
      // error so it shows up without blocking work at the boundaries where
      // untyped third-party payloads legitimately arrive.
      "@typescript-eslint/no-explicit-any": "warn",

      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
    },
  },

  // ── Node-side workspaces ───────────────────────────────────────────────────
  {
    files: ["apps/server/**/*.ts", "packages/shared/**/*.ts", "**/*.mjs", "scripts/**"],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
  },

  // ── React Native workspaces ────────────────────────────────────────────────
  {
    files: ["apps/rider/**/*.{ts,tsx}", "apps/driver/**/*.{ts,tsx}", "packages/mobile-shared/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2021,
        // React Native injects these; without them they read as undefined vars.
        __DEV__: "readonly",
        FormData: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
      parserOptions: { ecmaFeatures: { jsx: true }, ecmaVersion: 2022, sourceType: "module" },
    },
    plugins: { react, "react-hooks": reactHooks },
    settings: { react: { version: "detect" } },
    rules: {
      ...react.configs.flat.recommended.rules,
      // The new JSX transform means React need not be in scope.
      "react/react-in-jsx-scope": "off",
      // Expo Router screens are default exports with no propTypes; TS covers this.
      "react/prop-types": "off",
      // Off for React Native: this rule exists because a bare apostrophe or
      // quote in HTML can be ambiguous with surrounding markup. RN renders
      // <Text> children as a plain string — there is no HTML parser involved —
      // so escaping "don't" to "don&apos;t" would only make the source harder
      // to read for no correctness gain.
      "react/no-unescaped-entities": "off",
      "react-hooks/rules-of-hooks": "error",
      // Genuinely useful (stale closures cause real bugs here) but noisy to
      // adopt mid-project, so it reports without blocking.
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  // ── Tooling config files (babel/metro) ─────────────────────────────────────
  // CommonJS by necessity: Babel and Metro load these with require(), so
  // `module.exports`, `require` and `__dirname` are correct here, not smells.
  {
    files: ["**/babel.config.js", "**/metro.config.js", "**/*.config.js"],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: "commonjs",
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },

  // ── console.* exemptions ───────────────────────────────────────────────────
  {
    files: CONSOLE_ALLOWED,
    rules: { "no-console": "off" },
  },

  // Tests may also lean on `any` when stubbing awkward third-party shapes.
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },

  // Must come last: switches off every rule that would fight Prettier.
  prettier,
);
