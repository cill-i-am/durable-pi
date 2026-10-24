import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Cause, Deferred, Effect } from "effect"

import { fatalCause } from "../../shared/effect"
import { recoveryMachine } from "./recovery.machine"

export type RecoverySnapshot = {
  revision: string | null
  blocked: string | null
  online: boolean
  reloading: boolean
}
export const emptyRecovery: RecoverySnapshot = {
  revision: null,
  blocked: null,
  online: true,
  reloading: false,
}

/** Resource registrations are synchronous facts for beforeunload and the last
 * navigation fence. The actor owns reload admission and version-check work. */
export function makeRecovery(ports: {
  currentRevision: string
  reload: () => void
  version: (signal: AbortSignal) => Promise<unknown>
}) {
  return Effect.gen(function* () {
    const lifetime = new AbortController()
    const blockers = new Map<string, string>()
    const pending = new Set<Deferred.Deferred<boolean>>()
    let online = true
    let request: AbortController | undefined
    let nativeFailure: Cause.Cause<never> | undefined
    const facts = () => ({
      blocked: blockers.values().next().value ?? null,
      online,
    })
    const revoke = () => {
      lifetime.abort()
      request?.abort()
    }
    yield* Effect.addFinalizer(() =>
      Effect.forEach(pending, (reply) => Deferred.succeed(reply, false), {
        discard: true,
      })
    )
    // The official actor joins its invocation, but its interrupted child's Exit
    // is not the owner scope's Exit. Retain native teardown failure until that join.
    yield* Effect.addFinalizer(() =>
      nativeFailure ? Effect.failCause(nativeFailure) : Effect.void
    )
    const check = Effect.callback<unknown>((resume) => {
      const controller = new AbortController()
      request = controller
      const signal = AbortSignal.any([controller.signal, lifetime.signal])
      const work = Promise.resolve().then(() =>
        signal.aborted ? null : ports.version(signal)
      )
      work.then(
        (value) => resume(Effect.succeed(signal.aborted ? null : value)),
        (cause) => {
          if (
            Cause.isCause(cause) &&
            (Cause.hasDies(cause) || Cause.hasInterrupts(cause))
          ) {
            const failure = fatalCause(cause)
            nativeFailure = nativeFailure
              ? Cause.combine(nativeFailure, failure)
              : failure
            resume(Effect.failCause(failure))
          } else resume(Effect.succeed(null))
        }
      )
      return Effect.promise(async () => {
        controller.abort()
        // Rejection above retains structured failures before this promise joins;
        // the owner finalizer reports them after the actor has finished cleanup.
        await Promise.allSettled([work])
        if (request === controller) request = undefined
      })
    })
    const actor = yield* createEffectActor(
      recoveryMachine({
        currentRevision: ports.currentRevision,
        check,
        abortCheck: Effect.sync(() => request?.abort()),
        reload: Effect.sync(() => {
          if (lifetime.signal.aborted || facts().blocked || !online)
            return false
          try {
            ports.reload()
            return true
          } catch {
            return false
          }
        }),
      })
    )
    yield* Effect.addFinalizer(() => Effect.sync(revoke))
    let snapshot = emptyRecovery
    const listeners = new Set<() => void>()
    const subscription = actor.subscribe((state) => {
      const next = {
        revision: state.context.revision,
        blocked: state.context.blocked,
        online: state.context.online,
        reloading: !state.matches({ navigation: "idle" }),
      }
      if (JSON.stringify(next) === JSON.stringify(snapshot)) return
      snapshot = next
      listeners.forEach((listener) => listener())
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        subscription.unsubscribe()
        listeners.clear()
      })
    )
    const refresh = () => send(actor, { type: "FACTS", ...facts() })
    return {
      actor,
      revoke,
      snapshot: () => snapshot,
      blocked: () => facts().blocked,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      observe: (revision: unknown) =>
        send(actor, { type: "OBSERVE", revision }),
      connection: (value: boolean) =>
        Effect.sync(() => {
          online = value
        }).pipe(Effect.andThen(refresh)),
      block: (key: string, reason: string | null) =>
        Effect.sync(() => {
          if (reason) blockers.set(key, reason)
          else blockers.delete(key)
        }).pipe(Effect.andThen(refresh)),
      check: () =>
        lifetime.signal.aborted ? Effect.void : send(actor, { type: "CHECK" }),
      reload: () =>
        Effect.gen(function* () {
          if (
            lifetime.signal.aborted ||
            actor.getSnapshot().status !== "active"
          )
            return false
          const reply = yield* Deferred.make<boolean>()
          pending.add(reply)
          return yield* send(actor, { type: "RELOAD", reply }).pipe(
            Effect.andThen(
              Effect.raceFirst(
                Deferred.await(reply),
                waitFor(actor, (state) => state.status !== "active").pipe(
                  Effect.as(false),
                  Effect.catchCause(() => Effect.succeed(false))
                )
              )
            ),
            Effect.ensuring(Effect.sync(() => pending.delete(reply)))
          )
        }),
    }
  })
}
export type Recovery = Effect.Success<ReturnType<typeof makeRecovery>>

/** Browsers may deliver focus/visibility events concurrently; CHECK coalescing
 * belongs to the machine. Scope closure removes every listener and joins fetch. */
export function watchRecovery(
  recovery: Recovery,
  window: Window,
  document: Document
) {
  return Effect.gen(function* () {
    const inspect = () =>
      Effect.runSync(
        recovery
          .connection(window.navigator.onLine)
          .pipe(
            Effect.andThen(
              document.visibilityState === "visible"
                ? recovery.check()
                : Effect.void
            )
          )
      )
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (recovery.blocked()) event.preventDefault()
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        window.addEventListener("beforeunload", beforeUnload)
        for (const name of ["focus", "online", "offline", "vite:preloadError"])
          window.addEventListener(name, inspect)
        document.addEventListener("visibilitychange", inspect)
        inspect()
      }),
      () =>
        Effect.sync(() => {
          window.removeEventListener("beforeunload", beforeUnload)
          for (const name of [
            "focus",
            "online",
            "offline",
            "vite:preloadError",
          ])
            window.removeEventListener(name, inspect)
          document.removeEventListener("visibilitychange", inspect)
        })
    )
    return yield* Effect.never
  })
}

export function importFailure(error: unknown): error is Error {
  if (!(error instanceof Error)) return false
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading (?:CSS )?chunk [\w-]+ failed/i.test(
    error.message
  )
}
