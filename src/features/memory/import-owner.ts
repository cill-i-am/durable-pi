import { createEffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Schema } from "effect"

import { orDieAll } from "@/shared/effect"
import { nativeOperation } from "@/shared/interop"

import {
  MemoryImportResult,
  memoryImportMachine,
  type MemoryImportFile,
  type MemoryImportWork,
} from "./import.machine"

export const readMemoryImport = (file: MemoryImportFile) =>
  Effect.gen(function* () {
    if (file.size > 1_000_000)
      return yield* Effect.fail(new Error("Choose a file smaller than 1 MB."))
    const jsonl = yield* nativeOperation(
      () => file.text(),
      (cause) => cause
    )
    if (new TextEncoder().encode(jsonl).byteLength > 1_000_000)
      return yield* Effect.fail(new Error("Choose a file smaller than 1 MB."))
    return jsonl
  })
export const submitMemoryImport = (
  post: (jsonl: string, signal: AbortSignal) => Promise<unknown>,
  jsonl: string
) =>
  nativeOperation(
    (signal) => post(jsonl, signal),
    (cause) => cause
  ).pipe(Effect.map(Schema.decodeUnknownSync(MemoryImportResult)))

export function makeMemoryImport(work: MemoryImportWork) {
  return Effect.gen(function* () {
    let late: Cause.Cause<unknown> | undefined
    yield* Effect.addFinalizer(() =>
      late ? Effect.failCause(late).pipe(orDieAll) : Effect.void
    )
    const observe = <T, R>(work: Effect.Effect<T, unknown, R>) =>
      work.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (
              Exit.isFailure(exit) &&
              Cause.hasDies(exit.cause) &&
              Cause.hasInterrupts(exit.cause)
            )
              late = exit.cause
          })
        )
      )
    return yield* createEffectActor(
      memoryImportMachine({
        read: (file) => observe(work.read(file)),
        submit: (jsonl) => observe(work.submit(jsonl)),
      })
    )
  })
}
