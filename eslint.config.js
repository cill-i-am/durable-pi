import { tanstackConfig } from "@tanstack/eslint-config"
import { fileURLToPath } from "node:url"
import { domainBoundaries } from "./scripts/architecture-rules.mjs"

export default [
  ...tanstackConfig,
  {
    rules: {
      "import/no-cycle": "off",
      "import/order": "off",
      "import/consistent-type-specifier-style": "off",
      "sort-imports": "off",
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/require-await": "off",
      "pnpm/json-enforce-catalog": "off",
    },
  },
  {
    files: [
      "src/{access,activity,agent,agents,apps,auth,browser,communication,conversations,delegation,execution,inference,memory,objects,observability,planning,routines,shared,skills,storage,terminal,webhooks,workspace}/**/*.ts",
    ],
    ignores: [
      "**/*.test.ts",
      "src/auth/client.ts",
      "src/auth/session-fetch.ts",
    ],
    settings: {
      "import-x/extensions": [".ts", ".tsx", ".js", ".mjs", ".cjs"],
      "import-x/resolver": {
        node: {
          extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"],
          tsconfig: {
            configFile: fileURLToPath(
              new URL("./tsconfig.json", import.meta.url)
            ),
          },
        },
      },
    },
    rules: { "import/no-cycle": ["error", { ignoreExternal: true }] },
  },
  {
    files: [
      "src/memory/*.ts",
      "src/agents/*.ts",
      "src/activity/*.ts",
      "src/objects/*.ts",
      "src/planning/*.ts",
      "src/workspace/*.ts",
      "src/browser/*.ts",
      "src/shared/*.ts",
      "src/inference/*.ts",
      "src/delegation/*.ts",
      "src/execution/*.ts",
      "src/routines/*.ts",
      "src/webhooks/*.ts",
      "src/access/*.ts",
      "src/apps/*.ts",
      "src/skills/*.ts",
      "src/terminal/*.ts",
      "src/communication/*.ts",
      "src/conversations/*.ts",
    ],
    ignores: ["**/*.test.ts", "src/*/worker.ts"],
    plugins: { architecture: { rules: { boundaries: domainBoundaries } } },
    rules: { "architecture/boundaries": "error" },
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
    ignores: ["src/agents/*.test.ts"],
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
  {
    ignores: [
      "eslint.config.js",
      ".prettierrc",
      ".research/**",
      ".alchemy/**",
      "dist/**",
      "src/routeTree.gen.ts",
    ],
  },
]
