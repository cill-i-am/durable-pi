import { Cause, Effect } from "effect"
import type { AccessStore, ToolIntent } from "./adapters/sqlite"
import { AccessDenied } from "./contracts"

/** Owns the wait and final authorization fence; the host supplies the actual effect. */
export class AccessGate {
  private version = 0
  private listeners = new Set<() => void>()
  constructor(
    readonly store: AccessStore,
    private readonly canRun: (turnId: string) => boolean,
    private readonly onChange: () => void = () => {},
    private readonly botId: () => string | null = () => null
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
      const fields = {
        botId: this.botId(),
        runId: intent.turnId,
        operationId: intent.id,
        tool: intent.tool,
      }
      const observe = (event: string) =>
        Effect.annotateCurrentSpan({
          "bot.id": fields.botId ?? "",
          "run.id": intent.turnId,
          "tool.operation_id": intent.id,
          "tool.name": intent.tool,
        }).pipe(
          Effect.andThen(
            Effect.logInfo(event).pipe(
              Effect.annotateLogs({ ...fields, event })
            )
          ),
          Effect.withSpan(event),
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            () => Effect.void
          )
        )
      let waiting = false
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
          if (!waiting) yield* observe("tool.waiting")
          waiting = true
          yield* this.wait(version, operation.expiresAt)
          continue
        }
        if (typeof decision === "object") {
          yield* observe("tool.replayed")
          return yield* Effect.try(() => JSON.parse(decision.result) as T)
        }
        // claim synchronously records intent before invoking an effect that may not be replayable.
        try {
          yield* observe("tool.dispatched")
          const result = yield* Effect.tryPromise({
            try: work,
            catch: (cause) => cause,
          })
          yield* Effect.try({
            try: () => this.store.finish(intent.id, JSON.stringify(result)),
            catch: (cause) => cause,
          })
          yield* observe("tool.finished")
          return result
        } finally {
          this.notify()
        }
      }
    })
  }
}
