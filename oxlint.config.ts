import { correctness } from "@effect/tsgo/oxlint-presets"
import { defineConfig } from "oxlint"
import core from "ultracite/oxlint/core"
import react from "ultracite/oxlint/react"

// Keep Ultracite's safety rules; formatting and Effect idioms have their own owners.
const typeSafetyRules = [
  "constructor-super",
  "getter-return",
  "no-async-promise-executor",
  "no-compare-neg-zero",
  "no-cond-assign",
  "no-constant-binary-expression",
  "no-debugger",
  "no-dupe-else-if",
  "no-dupe-keys",
  "no-duplicate-case",
  "no-ex-assign",
  "no-fallthrough",
  "no-import-assign",
  "no-invalid-regexp",
  "no-loss-of-precision",
  "no-new-native-nonconstructor",
  "no-self-assign",
  "no-setter-return",
  "no-sparse-arrays",
  "no-this-before-super",
  "no-unreachable",
  "no-unsafe-finally",
  "no-unsafe-negation",
  "no-unsafe-optional-chaining",
  "use-isnan",
  "valid-typeof",
  "typescript/ban-ts-comment",
  "typescript/no-explicit-any",
  "typescript/no-floating-promises",
  "typescript/no-misused-promises",
  "typescript/no-unsafe-argument",
  "typescript/no-unsafe-assignment",
  "typescript/no-unsafe-call",
  "typescript/no-unsafe-declaration-merging",
  "typescript/no-unsafe-enum-comparison",
  "typescript/no-unsafe-function-type",
  "typescript/no-unsafe-member-access",
  "typescript/no-unsafe-return",
  "typescript/no-unsafe-unary-minus",
  "typescript/switch-exhaustiveness-check",
] as const
const reactSafetyRules = [
  "react/rules-of-hooks",
  "react/jsx-key",
  "react/jsx-no-duplicate-props",
  "react/jsx-no-script-url",
  "react/jsx-no-target-blank",
  "react/jsx-no-undef",
  "react/no-danger-with-children",
  "react/no-direct-mutation-state",
  "react/no-unknown-property",
  "react/void-dom-elements-no-children",
] as const

export default defineConfig({
  extends: [
    {
      ...core,
      rules: Object.fromEntries(
        typeSafetyRules.map((rule) => [rule, core.rules?.[rule] ?? "error"])
      ),
    },
    {
      ...react,
      rules: {},
    },
    {
      ...correctness,
      rules: Object.fromEntries(
        Object.keys(correctness.rules ?? {}).map((rule) => [
          rule,
          "error" as const,
        ])
      ),
    },
  ],
  categories: { correctness: "off" },
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    ".research/**",
    ".agents/**",
    "migrations/**",
    "patches/**",
  ],
  jsPlugins: [
    "./scripts/architecture-rules.mjs",
    "oxlint-plugin-effect/plugin",
  ],
  rules: {
    complexity: ["error", { max: 20, variant: "classic" }],
    "import/no-cycle": "off",
    "typescript/switch-exhaustiveness-check": [
      "error",
      { considerDefaultExhaustiveForUnions: true },
    ],
    // API stability labels are not correctness failures in application code.
    "effecttsgo/experimental-api-usage": "off",
    "effecttsgo/unstable-api-usage": "off",
    "effecttsgo/obsolete-match-import": "off",
    "effecttsgo/obsolete-schema-import": "off",
    // Existing schema contracts are structural; nominal branding changes their API.
    "effecttsgo/schema-class-missing-brand": "off",
    // Adapters and conformance tests may transport an unknown Cause before decoding it.
    "effecttsgo/any-unknown-in-error-context": "off",
    // React accepts async event handlers. Requiring void wrappers does not handle failures.
    "typescript/no-misused-promises": [
      "error",
      { checksVoidReturn: { attributes: false, arguments: false } },
    ],
    "effect/noEagerAcquire": "error",
    "effect/noManagedRuntimeInEffect": "error",
    "effect/noPerCallCacheConstruction": "error",
    "effect/noRunCollectOnUnboundedStream": "error",
    "effect/noUnboundedConcurrency": "error",
    "effect/noUnboundedRetry": "error",
  },
  overrides: [
    {
      // These scripts are not checked JavaScript; tests deliberately exercise malformed input.
      files: ["**/*.{js,mjs,cjs}", "tests/**"],
      rules: Object.fromEntries(
        typeSafetyRules
          .filter((rule) => rule.startsWith("typescript/no-unsafe-"))
          .map((rule) => [rule, "off" as const])
      ),
    },
    {
      files: [
        "src/**/*.{tsx,jsx}",
        "src/hooks/**/*.ts",
        "src/features/**/*.ts",
      ],
      rules: Object.fromEntries(
        reactSafetyRules.map((rule) => [rule, react.rules?.[rule] ?? "error"])
      ),
    },
    {
      files: [
        "src/{access,activity,agent,agents,apps,auth,browser,communication,conversations,delegation,execution,inference,memory,objects,observability,planning,routines,shared,skills,storage,terminal,webhooks,workspace}/**/*.ts",
      ],
      excludeFiles: [
        "**/*.test.ts",
        "src/auth/client.ts",
        "src/auth/session-fetch.ts",
      ],
      rules: { "import/no-cycle": ["error", { ignoreExternal: true }] },
    },
    {
      files: [
        "src/{memory,agents,activity,objects,planning,workspace,browser,shared,inference,delegation,execution,routines,webhooks,access,apps,skills,terminal,communication,conversations}/*.ts",
      ],
      excludeFiles: ["**/*.test.ts", "src/*/worker.ts"],
      rules: {
        "architecture/boundaries": "error",
        "effecttsgo/any-unknown-in-error-context": "error",
      },
    },
    {
      files: ["src/memory/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: [
                  "./adapters/*",
                  "../agent/*",
                  "../storage/*",
                  "@earendil-works/*",
                  "agents",
                  "agents/*",
                  "cloudflare:*",
                ],
                message:
                  "The memory context depends on its ports. Wire infrastructure and conversation adapters at the host.",
              },
            ],
          },
        ],
      },
    },
    {
      files: ["src/agents/*.ts"],
      excludeFiles: ["src/agents/*.test.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: [
                  "./adapters/*",
                  "../agent/*",
                  "../storage/*",
                  "cloudflare:*",
                  "react",
                  "agents",
                  "agents/*",
                ],
                message:
                  "Keep the Agents domain independent of its host and storage adapters.",
              },
            ],
          },
        ],
      },
    },
  ],
})
