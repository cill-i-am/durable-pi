import { Effect, ManagedRuntime } from "effect"
import {
  TerminalAuthoritySync,
  synchronizeTerminalAuthority,
  terminalAuthoritySyncLayer,
} from "../../src/agents/adapters/synchronization"

// Controlled loopback-free experiment, not a Cloudflare latency estimate.
// The simulated acknowledgment takes 25 ms; each condition performs ten
// identical projections in a fresh runtime. No credentials or cloud requests.
const samples = []
for (let sample = 0; sample < 10; sample++) {
  for (const cached of sample % 2 ? [true, false] : [false, true]) {
    let calls = 0
    const binding = {
      fetch: async () => {
        calls++
        await new Promise((resolve) => setTimeout(resolve, 25))
        return new Response(null, { status: 204 })
      },
    }
    const runtime = ManagedRuntime.make(
      terminalAuthoritySyncLayer(binding, "synthetic")
    )
    try {
      const start = performance.now()
      await runtime.runPromise(
        Effect.gen(function* () {
          const sync = yield* TerminalAuthoritySync
          for (let i = 0; i < 10; i++) {
            const projection = { revision: 1, active: true }
            yield* cached
              ? sync.sync(projection)
              : synchronizeTerminalAuthority(binding, "synthetic", projection)
          }
        })
      )
      samples.push({ sample, cached, ms: performance.now() - start, calls })
    } finally {
      await runtime.dispose()
    }
  }
}
console.log(
  JSON.stringify({ simulatedAckMs: 25, operations: 10, samples }, null, 2)
)
