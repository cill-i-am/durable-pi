import type { CredentialStore } from "@earendil-works/pi-ai"
import { Cause, Effect, Exit, ManagedRuntime } from "effect"
import { afterEach, expect } from "vitest"

import { createAgentModels as nativeModels } from "../src/inference/adapters/models-pi"
import {
  PiModelStreams,
  piModelStreamsLayer,
} from "../src/inference/adapters/streams-pi"

const runtimes = new Set<ManagedRuntime.ManagedRuntime<PiModelStreams, never>>()
const expected = new Map<
  ManagedRuntime.ManagedRuntime<PiModelStreams, never>,
  unknown
>()
const owners = new WeakMap<
  object,
  ManagedRuntime.ManagedRuntime<PiModelStreams, never>
>()
export function expectModelDefect(models: object, defect: unknown) {
  const owner = owners.get(models)
  if (!owner) throw new Error("Model fixture has no retained owner")
  expected.set(owner, defect)
}
afterEach(async () => {
  for (const runtime of runtimes) {
    runtimes.delete(runtime)
    const exit = await Effect.runPromiseExit(runtime.disposeEffect)
    const defect = expected.get(runtime)
    if (defect)
      expect(
        Exit.isFailure(exit) &&
          exit.cause.reasons.some(
            (reason) => reason._tag === "Die" && reason.defect === defect
          )
      ).toBe(true)
    else if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
    expected.delete(runtime)
  }
})
export function createAgentModels(
  credentials: CredentialStore,
  options: Omit<Parameters<typeof nativeModels>[1], "start"> = {}
) {
  const runtime = makeRuntime()
  const streams = runtime.runSync(PiModelStreams)
  const models = nativeModels(credentials, {
    ...options,
    start: (request) => runtime.runSync(streams.start(request)),
  })
  owners.set(models, runtime)
  return models
}
function makeRuntime() {
  const runtime = ManagedRuntime.make(piModelStreamsLayer)
  runtimes.add(runtime)
  return runtime
}
export function modelStart() {
  const runtime = makeRuntime()
  const streams = runtime.runSync(PiModelStreams)
  return (request: Parameters<typeof streams.start>[0]) =>
    runtime.runSync(streams.start(request))
}
