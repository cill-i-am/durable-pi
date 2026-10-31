import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Alchemy from "alchemy"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"

import { NativeTerminalWorker, TerminalWorker } from "../alchemy.run"

export const SandboxRehearsal = Cloudflare.Worker("SandboxRehearsal", {
  main: "./src/terminal/adapters/rehearsal-worker.ts",
  compatibility: { date: "2026-10-02", flags: ["nodejs_compat"] },
  workersDev: { enabled: true, previewsEnabled: false },
  observability: { enabled: false },
  env: {
    NATIVE: NativeTerminalWorker,
    LEGACY: TerminalWorker,
    TOKEN: Config.Redacted("SANDBOX_REHEARSAL_TOKEN"),
  },
})
export type SandboxRehearsalEnv = Cloudflare.InferEnv<typeof SandboxRehearsal>
export default Alchemy.Stack(
  "durable-pi-sandbox-rehearsal",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const probe = yield* SandboxRehearsal
    return { url: probe.url }
  })
)
