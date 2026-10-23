import {
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  Layer,
  Schema,
  Semaphore,
} from "effect"

import { orDieAll } from "../shared/effect"
import {
  BrowserFailure,
  allowedBrowserUrl,
  browserState,
  browserDeadline,
  type BrowserPolicy,
  type BrowserController,
  type BrowserAction,
  type BrowserInteraction,
  type BrowserCapture,
} from "./contracts"
import { requireBrowserGeneration } from "./domain"
import type { BrowserDriver, BrowserUnavailable } from "./driver"
import { runBrowserOperation } from "./operation"
import { BrowserStorageError, type BrowserRepository } from "./repository"
import { retireBrowser } from "./retirement"
import { interruptedBrowserMessage } from "./session.machine"

export type { BrowserRepository } from "./repository"
export type { BrowserDriver } from "./driver"
const attempt = <T>(body: () => T) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const error = Schema.decodeUnknownOption(
        Schema.Union([BrowserFailure, BrowserStorageError])
      )(cause)
      if (error._tag === "Some") return error.value
      throw cause
    },
  })

export class BrowserWorkspace {
  private readonly operations = Semaphore.makeUnsafe(1)
  constructor(
    private readonly repository: BrowserRepository,
    private readonly driver: BrowserDriver,
    private readonly writable: () => Effect.Effect<
      boolean,
      BrowserStorageError
    >,
    private readonly wake: () => Effect.Effect<void, BrowserUnavailable>
  ) {}
  state = Effect.fn("Browser.state")(() =>
    Effect.gen({ self: this }, function* () {
      const now = yield* Clock.currentTimeMillis
      return browserState(yield* this.repository.read(), now)
    })
  )
  preview = Effect.fn("Browser.preview")(() =>
    this.repository.read().pipe(
      Effect.map((record) => ({
        version: record.version,
        screenshot: record.capture?.screenshot ?? null,
      }))
    )
  )
  maintenancePending = Effect.fn("Browser.maintenancePending")(() =>
    this.repository.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const record = yield* this.repository.read()
        const retired = yield* this.repository.retired()
        return !!record.session || retired.length > 0
      })
    )
  )
  private check(generation: number) {
    return Effect.gen({ self: this }, function* () {
      if (!(yield* this.writable()))
        return yield* new BrowserFailure({ message: "This bot is archived." })
      const record = yield* this.repository.read()
      yield* attempt(() => requireBrowserGeneration(record, generation))
      return record
    })
  }
  configure = Effect.fn("Browser.configure")((policy: BrowserPolicy) =>
    Effect.gen({ self: this }, function* () {
      yield* this.repository.atomic(() =>
        Effect.gen({ self: this }, function* () {
          yield* this.check(policy.generation)
          yield* this.repository.advance({
            type: "RESET",
            generation: policy.generation,
            hosts: policy.hosts,
            unrestricted: policy.unrestricted ?? false,
          })
        })
      )
      yield* this.wake()
      return yield* this.state()
    }).pipe(Effect.uninterruptible)
  )
  close = Effect.fn("Browser.close")((generation: number) =>
    Effect.gen({ self: this }, function* () {
      yield* this.repository.atomic(() =>
        Effect.gen({ self: this }, function* () {
          const current = yield* this.repository.read()
          yield* this.repository.advance({
            type: "RESET",
            generation,
            hosts: current.hosts,
            unrestricted: current.unrestricted,
          })
        })
      )
      yield* this.wake()
      return yield* this.state()
    }).pipe(Effect.uninterruptible)
  )
  control = Effect.fn("Browser.control")(
    (generation: number, controller: BrowserController) =>
      Effect.gen({ self: this }, function* () {
        const now = yield* Clock.currentTimeMillis
        const record = yield* this.repository.atomic(() =>
          Effect.gen({ self: this }, function* () {
            yield* this.check(generation)
            return yield* this.repository.advance({
              type: "TRANSFER",
              generation,
              controller,
              now,
            })
          })
        )
        yield* this.inspect(record.generation, undefined, undefined, "owner")
        return yield* this.state()
      })
  )
  recover = Effect.fn("Browser.recover")(() =>
    this.repository.advance({ type: "RECOVER" }).pipe(Effect.asVoid)
  )
  inspect(
    generation: number,
    url?: string,
    signal?: AbortSignal,
    actor: BrowserController = "agent"
  ) {
    return this.perform(
      generation,
      url === undefined ? { kind: "inspect" } : { kind: "navigate", url },
      actor,
      signal
    )
  }
  interact(
    input: BrowserInteraction,
    actor: BrowserController,
    signal?: AbortSignal
  ) {
    return this.perform(
      input.generation,
      { kind: "interact", version: input.version, action: input.action },
      actor,
      signal
    )
  }
  private perform(
    generation: number,
    operation:
      | { kind: "inspect" }
      | { kind: "navigate"; url: string }
      | { kind: "interact"; version: number; action: BrowserAction },
    actor: BrowserController,
    signal?: AbortSignal
  ) {
    return Effect.suspend(() => {
      const attemptId = crypto.randomUUID()
      const failure = (dispatched: boolean, cause?: BrowserFailure) =>
        new BrowserFailure({
          message:
            cause?.message ??
            (dispatched && operation.kind === "inspect"
              ? "The browser page could not be read. Refresh its view; if the session expired, close it and open a page again."
              : dispatched
                ? "The browser operation could not finish and may have run. Inspect the page before trying again, or close an expired session."
                : "The browser service could not open a session. Try opening a page again; if this persists, check Cloudflare Browser Run."),
          outcome:
            cause?.outcome ??
            (!dispatched || operation.kind === "inspect"
              ? "rejected"
              : "uncertain"),
        })
      const classify = <A>(
        work: Effect.Effect<
          A,
          BrowserFailure | BrowserUnavailable | BrowserStorageError
        >,
        dispatched: boolean
      ) =>
        work.pipe(
          Effect.catchCause((cause) =>
            Effect.failCause(
              Cause.map(cause, (reason) =>
                reason._tag === "BrowserStorageError"
                  ? reason
                  : failure(
                      dispatched,
                      reason._tag === "BrowserFailure" ? reason : undefined
                    )
              )
            )
          )
        )
      const check = (owned = false) =>
        this.check(generation).pipe(
          Effect.flatMap((record) =>
            attempt(() => {
              if (actor === "agent" && record.controller === "owner")
                throw new BrowserFailure({
                  message:
                    "The owner has browser control. Wait for them to return control before using browser tools.",
                })
              if (signal?.aborted)
                throw new BrowserFailure({
                  message: "This browser action was stopped.",
                })
              if (owned && record.attemptId !== attemptId)
                throw new BrowserFailure({
                  message:
                    "This browser operation was superseded. Inspect the page before continuing.",
                  outcome: "uncertain",
                })
              return record
            })
          )
        )
      const admit = Effect.gen({ self: this }, function* () {
        const record = yield* check()
        if (!record.unrestricted && !record.hosts.length)
          return yield* new BrowserFailure({
            message:
              "Add allowed sites or enable unrestricted internet in Browser settings before browsing.",
          })
        if (operation.kind === "navigate")
          yield* attempt(() =>
            allowedBrowserUrl(operation.url, record.hosts, record.unrestricted)
          )
        else if (!record.session)
          return yield* new BrowserFailure({ message: "Open a page first." })
        const now = yield* Clock.currentTimeMillis
        if (record.session && browserDeadline(record.session) <= now) {
          yield* this.repository
            .advance({
              type: "RESET",
              generation,
              hosts: record.hosts,
              unrestricted: record.unrestricted,
            })
            .pipe(Effect.andThen(this.wake()), Effect.uninterruptible)
          return yield* new BrowserFailure({
            message:
              "This browser session expired. Reopen the page to start a fresh session.",
          })
        }
        return yield* this.repository.atomic(() =>
          Effect.gen({ self: this }, function* () {
            yield* check()
            return yield* this.repository.advance({
              type: "BEGIN",
              generation,
              attemptId,
              kind: operation.kind,
              version: operation.kind === "interact" ? operation.version : null,
              actor,
              now: yield* Clock.currentTimeMillis,
            })
          })
        )
      })
      const work = runBrowserOperation<BrowserFailure | BrowserStorageError>({
        admit: classify(admit, false),
        acquire: (record) =>
          classify(
            Effect.scoped(
              Effect.gen({ self: this }, function* () {
                let adopted = false
                const session = yield* Effect.acquireRelease(
                  this.driver.open(record.hosts, record.unrestricted),
                  (value) =>
                    adopted
                      ? Effect.void
                      : this.repository.retire(value.id).pipe(
                          Effect.onError(() =>
                            this.driver.close(value.id).pipe(orDieAll)
                          ),
                          orDieAll,
                          Effect.andThen(this.wake().pipe(orDieAll))
                        )
                )
                const now = yield* Clock.currentTimeMillis
                return yield* this.repository
                  .atomic(() =>
                    Effect.gen({ self: this }, function* () {
                      yield* check(true)
                      const value = yield* this.repository.advance({
                        type: "ADOPT",
                        generation,
                        attemptId,
                        session,
                        now,
                      })
                      return value
                    })
                  )
                  .pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        adopted = true
                      })
                    ),
                    Effect.tap(() => this.wake()),
                    Effect.uninterruptible
                  )
              })
            ),
            false
          ),
        dispatch: (record) =>
          Effect.gen({ self: this }, function* () {
            yield* classify(check(true), false)
            const native =
              operation.kind === "navigate"
                ? this.driver.navigate(
                    record.session!,
                    allowedBrowserUrl(
                      operation.url,
                      record.hosts,
                      record.unrestricted
                    ),
                    record.hosts,
                    record.unrestricted
                  )
                : operation.kind === "interact"
                  ? this.driver.interact(
                      record.session!,
                      operation.action,
                      record.capture!.page.url,
                      record.hosts,
                      actor,
                      record.unrestricted
                    )
                  : this.driver.capture(
                      record.session!,
                      record.hosts,
                      record.unrestricted
                    )
            return yield* classify(native, true)
          }),
        publish: (record, capture: BrowserCapture) =>
          Effect.gen({ self: this }, function* () {
            const now = yield* Clock.currentTimeMillis
            return yield* this.repository.atomic(() =>
              Effect.gen({ self: this }, function* () {
                yield* check(true)
                const next = yield* this.repository.advance({
                  type: "CAPTURED",
                  generation,
                  attemptId,
                  session: record.session!,
                  capture,
                  now,
                })
                return { ...capture, generation, version: next.version }
              })
            )
          }),
      }).pipe(
        Effect.onExit((exit) => {
          if (Exit.isSuccess(exit)) return Effect.void
          const failure = exit.cause.reasons.find(
            (reason) =>
              reason._tag === "Fail" && reason.error._tag === "BrowserFailure"
          )
          const message =
            failure?._tag === "Fail" && failure.error._tag === "BrowserFailure"
              ? failure.error.message
              : interruptedBrowserMessage
          return this.repository
            .atomic(() =>
              Effect.gen({ self: this }, function* () {
                const current = yield* this.repository.read()
                if (
                  current.generation === generation &&
                  current.attemptId === attemptId
                )
                  yield* this.repository.advance({
                    type: "FAILED",
                    generation,
                    attemptId,
                    message,
                  })
              })
            )
            .pipe(orDieAll)
        })
      )
      return this.operations.withPermit(work)
    }).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Browser.operationFailed").pipe(
          Effect.annotateLogs({
            operation: operation.kind,
            outcome:
              error._tag === "BrowserFailure" ? error.outcome : "storage",
            message:
              error._tag === "BrowserFailure"
                ? error.message
                : "Browser storage unavailable",
          })
        )
      ),
      Effect.withSpan("Browser.perform", {
        attributes: { "browser.operation": operation.kind },
      })
    )
  }

  cleanup = Effect.fn("Browser.cleanup")(() =>
    Effect.gen({ self: this }, function* () {
      const now = yield* Clock.currentTimeMillis
      yield* this.repository.atomic(() =>
        Effect.gen({ self: this }, function* () {
          yield* this.repository.advance({
            type: "MAINTAIN",
            now,
            writable: yield* this.writable(),
          })
        })
      )
      let retry = false
      for (const id of yield* this.repository.retired()) {
        const closed = yield* retireBrowser<
          BrowserFailure | BrowserUnavailable | BrowserStorageError
        >(this.driver.close(id), this.repository.forget(id))
        if (!closed) retry = true
      }
      const session = (yield* this.repository.read()).session
      const deadline = session ? browserDeadline(session) : undefined
      return retry
        ? Math.min(
            (yield* Clock.currentTimeMillis) + 30000,
            deadline ?? Infinity
          )
        : deadline
    })
  )
}
export type BrowserService = Pick<
  BrowserWorkspace,
  | "state"
  | "preview"
  | "maintenancePending"
  | "configure"
  | "close"
  | "control"
  | "recover"
  | "inspect"
  | "interact"
  | "cleanup"
>
export class Browser extends Context.Service<Browser, BrowserService>()(
  "Browser"
) {}
export const browserApplication = (
  repository: BrowserRepository,
  driver: BrowserDriver,
  writable: () => Effect.Effect<boolean, BrowserStorageError>,
  wake: () => Effect.Effect<void, BrowserUnavailable>
) =>
  Layer.succeed(
    Browser,
    new BrowserWorkspace(repository, driver, writable, wake)
  )
