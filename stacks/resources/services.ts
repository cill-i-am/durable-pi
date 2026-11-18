import * as Cloudflare from "@alchemy.run/cloudflare"

import { privateWorker } from "./worker-settings"

export const DocumentWorker = Cloudflare.Worker("DocumentWorker", {
  main: "./src/workspace/adapters/document-worker.ts",
  dev: { port: 1339, strictPort: true },
  ...privateWorker,
  compatibility: { date: "2026-09-25", flags: ["nodejs_compat"] },
  limits: { cpuMs: 5_000 },
})
export const ExecutionWorker = Cloudflare.Worker("ExecutionWorker", {
  main: "./src/execution/worker.ts",
  dev: { port: 1340, strictPort: true },
  ...privateWorker,
  compatibility: { date: "2026-09-25", flags: ["nodejs_compat"] },
  limits: { cpuMs: 2000 },
  env: { LOADER: Cloudflare.WorkerLoader() },
})
export type ExecutionEnv = Cloudflare.InferEnv<typeof ExecutionWorker>
