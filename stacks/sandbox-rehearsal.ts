import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"

import { NativeTerminalWorker } from "../alchemy.run"

// This stack owns its own namespace and local R2 state. It does not switch
// production traffic or import checkpoints from the existing Sandbox class.
export default Alchemy.Stack(
  "durable-pi-sandbox-rehearsal",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* NativeTerminalWorker
    return { url: worker.url }
  })
)
