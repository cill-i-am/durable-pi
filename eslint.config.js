//  @ts-check

import { tanstackConfig } from "@tanstack/eslint-config"

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
