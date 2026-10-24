import { createEffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Schema } from "effect"

import { fatalCause } from "@/shared/effect"
import { nativeOperation } from "@/shared/interop"

import {
  MemoryBranch,
  MemoryMatches,
  MemoryTreePart,
  memoryQueryMachine,
  type MemoryQuery,
  type MemoryQueryData,
  type MemoryQueryWork,
} from "./query.machine"

export const memoryQueryRead =
  (
    api: (path: string, signal: AbortSignal) => Promise<unknown>
  ): MemoryQueryWork =>
  (request) =>
    Effect.gen(function* () {
      const part = request.kind === "tree" ? request.trail.at(-1) : undefined
      const path =
        request.kind === "search"
          ? `search?q=${encodeURIComponent(request.query)}`
          : request.kind === "source"
            ? `tree?id=${request.source}&n=1`
            : part
              ? `tree?id=${part.start}&n=${part.count}`
              : "tree"
      const value = yield* nativeOperation(
        (signal) => api(path, signal),
        (cause) => cause
      )
      return yield* Effect.try({
        try: (): MemoryQueryData => {
          const empty = { results: [], parts: [], original: null, trail: [] }
          if (request.kind === "search")
            return {
              ...empty,
              results: Schema.decodeUnknownSync(MemoryMatches)(value),
            }
          if (request.kind === "tree" && !part)
            return {
              ...empty,
              parts: Schema.decodeUnknownSync(Schema.Array(MemoryTreePart))(
                value
              ),
            }
          const branch = Schema.decodeUnknownSync(MemoryBranch)(value)
          return {
            ...empty,
            parts: branch.children,
            original: branch.original,
            trail: request.kind === "tree" ? request.trail : [],
          }
        },
        catch: (cause) => cause,
      })
    })

export function makeMemoryQuery(
  input: MemoryQuery | null,
  read: MemoryQueryWork
) {
  return Effect.gen(function* () {
    const failures = new Set<Cause.Cause<unknown>>()
    // Register before the actor: its native invocation scopes drain first.
    yield* Effect.addFinalizer(() =>
      failures.size
        ? Effect.failCause(
            fatalCause(
              Cause.fromReasons([...failures].flatMap((cause) => cause.reasons))
            )
          )
        : Effect.void
    )
    return yield* createEffectActor(
      memoryQueryMachine((request) =>
        read(request).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (
                Exit.isFailure(exit) &&
                (Cause.hasDies(exit.cause) ||
                  (Cause.hasInterrupts(exit.cause) &&
                    !Cause.hasInterruptsOnly(exit.cause)))
              )
                failures.add(exit.cause)
            })
          )
        )
      ),
      { input }
    )
  })
}
