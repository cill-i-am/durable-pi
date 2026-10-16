import { createRequire } from "node:module"

const requireAlchemy = createRequire(import.meta.resolve("alchemy"))
const { build } = requireAlchemy("esbuild")

// Compile the four production entrypoints independently of the website and
// native fixtures. This performs local bundling, without evaluating the stack.
await build({
  entryPoints: [
    "src/agent/worker.ts",
    "src/execution/worker.ts",
    "src/terminal/worker.ts",
    "src/terminal/adapters/native-worker.ts",
    "src/workspace/adapters/document-worker.ts",
  ],
  outdir: "dist/workers",
  outbase: "src",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  external: ["cloudflare:*", "node:*"],
  logLevel: "info",
})
