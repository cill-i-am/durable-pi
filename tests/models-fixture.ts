import { afterEach } from "vitest"
import { ManagedRuntime } from "effect"
import type { CredentialStore } from "@earendil-works/pi-ai"
import { createAgentModels as nativeModels } from "../src/inference/adapters/models-pi"
import {
  PiModelStreams,
  piModelStreamsLayer,
} from "../src/inference/adapters/streams-pi"

const runtimes = new Set<ManagedRuntime.ManagedRuntime<PiModelStreams, never>>()
afterEach(async () => {
  for (const runtime of runtimes) {
    runtimes.delete(runtime)
    await runtime.dispose()
  }
})
export function createAgentModels(
  credentials: CredentialStore,
  options: Omit<Parameters<typeof nativeModels>[1], "start"> = {}
) {
  return nativeModels(credentials, { ...options, start: modelStart() })
}
export function modelStart() {
  const runtime = ManagedRuntime.make(piModelStreamsLayer)
  runtimes.add(runtime)
  const streams = runtime.runSync(PiModelStreams)
  return (request: Parameters<typeof streams.start>[0]) =>
    runtime.runSync(streams.start(request))
}
