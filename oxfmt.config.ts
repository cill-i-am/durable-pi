import { defineConfig } from "oxfmt"
import ultracite from "ultracite/oxfmt"

export default defineConfig({
  ...ultracite,
  semi: false,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    ".research/**",
    ".agents/**",
    "migrations/**",
    "patches/**",
  ],
  sortImports: {
    ignoreCase: true,
    newlinesBetween: true,
    order: "asc",
    internalPattern: ["@/"],
    sortSideEffects: false,
  },
  sortTailwindcss: {
    stylesheet: "./src/styles.css",
    functions: ["cn", "cva"],
  },
})
