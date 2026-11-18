import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Alchemy from "alchemy"
import * as Effect from "effect/Effect"

import type { NativeCapacityRPC } from "../../src/terminal/adapters/capacity"
import type { LinuxSandboxV1 } from "../../src/terminal/adapters/native-worker"
import type { LinuxSandbox } from "../../src/terminal/worker"
import { WorkspaceAssets } from "./storage"
import { privateWorker } from "./worker-settings"

// Separate native namespace preserves the legacy namespace during cutover.
const TerminalImage = Cloudflare.Container("TerminalImage", {
  schedulingPolicy: "durable_object",
  context: "./containers/terminal-native",
  observability: { logs: { enabled: false } },
})
const NativeCapacity: Cloudflare.DurableObjectLike<NativeCapacityRPC> =
  Cloudflare.DurableObject("NativeTerminalCapacity")
export const NativeTerminalWorker = Cloudflare.Worker(
  "TerminalWorkerSandboxV1",
  {
    main: "./src/terminal/adapters/native-worker.ts",
    dev: { port: 1342, strictPort: true },
    ...privateWorker,
    compatibility: { date: "2026-10-02", flags: ["nodejs_compat"] },
    env: {
      SANDBOX: Cloudflare.DurableObject<LinuxSandboxV1>("LinuxSandboxV1", {
        containers: [TerminalImage],
      }),
      BACKUPS: WorkspaceAssets,
      CAPACITY: NativeCapacity,
    },
  }
)
export type NativeTerminalEnv = Cloudflare.InferEnv<typeof NativeTerminalWorker>
export const TerminalWorker = Cloudflare.Worker(
  "TerminalWorkerDrizzleV1",
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage
    return {
      main: "./src/terminal/worker.ts",
      dev: { port: 1341, strictPort: true },
      ...privateWorker,
      compatibility: { date: "2026-09-25", flags: ["nodejs_compat"] },
      env: {
        SANDBOX: Cloudflare.Container<LinuxSandbox>("LinuxSandboxDrizzleV1", {
          className: "LinuxSandbox",
          context: "./containers/terminal",
          instanceType: "basic",
          maxInstances: 4,
          observability: { logs: { enabled: false } },
        }),
        BACKUPS: WorkspaceAssets,
        LEGACY_FROZEN: stage === "production",
        NATIVE_SERVICE: NativeTerminalWorker,
        SANDBOX_LOG_LEVEL: "error",
        SANDBOX_TRANSPORT: "rpc",
      },
    }
  })
)
export type TerminalEnv = Cloudflare.InferEnv<typeof TerminalWorker>
