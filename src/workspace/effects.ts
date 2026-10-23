import { Cause, Equal, Exit, Schema, Effect, Semaphore } from "effect"

import { fatalCause } from "../shared/effect"
import {
  FileNotFound,
  FileRejected,
  WorkspaceReadOnly,
  WorkspaceUnavailable,
} from "./files"

/** Translate checked synchronous decisions/ledger failures; preserve defects. */
export const workspaceOperation = <T>(body: () => T) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const knownFailure = Schema.decodeUnknownOption(
        Schema.Union([
          FileNotFound,
          FileRejected,
          WorkspaceReadOnly,
          WorkspaceUnavailable,
        ])
      )(cause)
      if (knownFailure._tag === "Some") return knownFailure.value
      throw cause
    },
  })

/** alpha.8 interrupts stopped invocations, but only owning scope closure joins
 * them. Keep their late failures until that join has completed. */
export const workspaceScope = <A, E>(
  run: (
    observe: <B, E2>(work: Effect.Effect<B, E2>) => Effect.Effect<B, E2>
  ) => Effect.Effect<A, E, import("effect").Scope.Scope>
): Effect.Effect<A, E> =>
  Effect.suspend(() => {
    const failed: import("effect").Cause.Cause<unknown>[] = []
    const observe = <B, E2>(work: Effect.Effect<B, E2>) =>
      work.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isFailure(exit)) failed.push(exit.cause)
          })
        )
      )
    return run(observe).pipe(
      Effect.scoped,
      Effect.onExit((exit) => {
        if (!Exit.isFailure(exit) || !Cause.hasInterrupts(exit.cause))
          return Effect.void
        const reasons = failed
          .flatMap((cause) => cause.reasons)
          .filter(
            (reason) =>
              reason._tag !== "Interrupt" &&
              !exit.cause.reasons.some((present) =>
                Equal.equals(present, reason)
              )
          )
        return reasons.length
          ? Effect.failCause(fatalCause(Cause.fromReasons(reasons)))
          : Effect.void
      })
    )
  })

/** Occupancy follows the shared ledger, not a newly constructed facade. The
 * caller holds these permits until its Effect scope and native cleanup join. */
const occupancy = new WeakMap<
  object,
  {
    preparation: Semaphore.Semaphore
    uploads: Map<string, { permit: Semaphore.Semaphore; users: number }>
    attempts: Map<string, { fileId: string; phase: "live" | "joined" }>
  }
>()
export function workspaceOccupancy(group: object) {
  let state = occupancy.get(group)
  if (!state) {
    state = {
      preparation: Semaphore.makeUnsafe(1),
      uploads: new Map(),
      attempts: new Map(),
    }
    occupancy.set(group, state)
  }
  return {
    preparation: state.preparation,
    start: (fileId: string, token: string) => {
      for (const [previous, owner] of state.attempts)
        if (owner.fileId === fileId && owner.phase === "joined")
          state.attempts.delete(previous)
      state.attempts.set(token, { fileId, phase: "live" })
    },
    finish: (token: string, failed: boolean) => {
      const owner = state.attempts.get(token)
      if (!owner) return
      if (failed) state.attempts.set(token, { ...owner, phase: "joined" })
      else state.attempts.delete(token)
    },
    joined: (token: string) => state.attempts.get(token)?.phase === "joined",
    retire: (token: string) => {
      if (state.attempts.get(token)?.phase === "joined")
        state.attempts.delete(token)
    },
    upload: <A, E, R>(id: string, work: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        let entry = state.uploads.get(id)
        if (!entry) {
          entry = { permit: Semaphore.makeUnsafe(1), users: 0 }
          state.uploads.set(id, entry)
        }
        entry.users++
        const owned = entry
        return owned.permit
          .withPermits(1)(work)
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (--owned.users === 0) state.uploads.delete(id)
              })
            )
          )
      }),
  }
}
