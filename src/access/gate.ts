import { Effect } from "effect"
import type { AccessStore, ToolIntent } from "./adapters/sqlite"
import { AccessDenied } from "./contracts"

/** Owns the wait and final authorization fence; the host supplies the actual effect. */
export class AccessGate {
  private version = 0
  private listeners = new Set<() => void>()
  constructor(
    readonly store: AccessStore,
    private readonly canRun: (turnId: string) => boolean,
    private readonly onChange: () => void = () => {}
  ) {}
  notify() {
    this.version++
    for (const listener of [...this.listeners]) listener()
    this.onChange()
  }
  private wait(version: number, expiresAt: number) {
    return Effect.tryPromise({
      try: (signal) =>
        new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            this.listeners.delete(done)
            signal.removeEventListener("abort", abort)
            clearTimeout(timer)
          }
          const done = () => {
            cleanup()
            resolve()
          }
          const abort = () => {
            cleanup()
            reject(new AccessDenied({ message: "Tool wait interrupted." }))
          }
          const timer = setTimeout(
            done,
            Math.max(1, Math.min(60_000, expiresAt - Date.now()))
          )
          if (signal.aborted) return abort()
          this.listeners.add(done)
          signal.addEventListener("abort", abort, { once: true })
          if (this.version !== version) done()
        }),
      catch: (cause) => cause,
    })
  }
  run<T>(
    intent: ToolIntent,
    work: () => Promise<T>,
    recoverable = false
  ): Effect.Effect<T, unknown> {
    return Effect.gen({ self: this }, function* () {
      const operation = yield* Effect.try({
        try: () => {
          if (!this.canRun(intent.turnId))
            throw new AccessDenied({
              message: "This reply has stopped or its bot is archived.",
            })
          return this.store.begin(intent)
        },
        catch: (cause) => cause,
      })
      this.notify()
      for (;;) {
        const version = this.version
        const decision = yield* Effect.try({
          try: () => {
            if (!this.canRun(operation.turnId))
              throw new AccessDenied({
                message: "This reply has stopped or its bot is archived.",
              })
            return this.store.claim(intent.id, recoverable)
          },
          catch: (cause) => cause,
        })
        if (decision === "pending") {
          yield* this.wait(version, operation.expiresAt)
          continue
        }
        if (typeof decision === "object") {
          yield* Effect.annotateCurrentSpan("tool.replayed", true)
          return yield* Effect.try(() => JSON.parse(decision.result) as T)
        }
        // claim synchronously records intent before invoking an effect that may not be replayable.
        try {
          yield* Effect.annotateCurrentSpan("tool.dispatched", true)
          const result = yield* Effect.tryPromise(work)
          yield* Effect.try({
            try: () => this.store.finish(intent.id, JSON.stringify(result)),
            catch: (cause) => cause,
          })
          return result
        } finally {
          this.notify()
        }
      }
    }).pipe(
      Effect.withSpan("Access.tool", {
        attributes: {
          "tool.name": intent.tool,
          "tool.operation_id": intent.id,
          "run.id": intent.turnId,
        },
      })
    )
  }
}
