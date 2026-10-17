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
  BROWSER_IDLE_MS,
  type BrowserPolicy,
  type BrowserController,
  type BrowserAction,
  type BrowserInteraction,
  type BrowserCapture,
} from "./contracts"
import { requireBrowserGeneration } from "./domain"
import type { BrowserDriver, BrowserUnavailable } from "./driver"
import { BrowserStorageError, type BrowserRepository } from "./repository"

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
const interruptedMessage =
  "The browser operation was interrupted and may have run. Inspect the page before trying again."

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
          yield* this.repository.reset(
            policy.generation,
            policy.hosts,
            policy.unrestricted ?? false
          )
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
          yield* this.repository.reset(
            generation,
            current.hosts,
            current.unrestricted
          )
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
            const current = yield* this.check(generation)
            if (!current.session || browserDeadline(current.session) <= now)
              return yield* new BrowserFailure({
                message: "Open a page before taking control.",
              })
            return yield* this.repository.transfer(generation, controller)
          })
        )
        yield* this.inspect(record.generation, undefined, undefined, "owner")
        return yield* this.state()
      })
  )
  recover = Effect.fn("Browser.recover")(() =>
    this.repository.atomic(() =>
      Effect.gen({ self: this }, function* () {
        const record = yield* this.repository.read()
        if (record.status === "loading")
          yield* this.repository.update(record.generation, {
            status: "error",
            capture: null,
            error: interruptedMessage,
          })
      })
    )
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
      let dispatched = false,
        started = false,
        error: BrowserFailure | undefined
      const failure = (cause?: BrowserFailure) =>
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
      const check = () =>
        this.check(generation).pipe(
          Effect.flatMap((record) =>
            attempt(() => {
              if (actor === "agent" && record.controller === "owner")
                throw new BrowserFailure({
                  message:
                    "The owner has browser control. Wait for them to return control before using browser tools.",
                })
              if (
                operation.kind === "interact" &&
                actor === "owner" &&
                record.controller !== "owner"
              )
                throw new BrowserFailure({
                  message: "Take control before interacting with this page.",
                })
              if (signal?.aborted)
                throw new BrowserFailure({
                  message: "This browser action was stopped.",
                })
              return record
            })
          )
        )
      const work = Effect.scoped(
        Effect.gen({ self: this }, function* () {
          let record = yield* check()
          if (!record.unrestricted && !record.hosts.length)
            return yield* new BrowserFailure({
              message:
                "Add allowed sites or enable unrestricted internet in Browser settings before browsing.",
            })
          const destination = yield* attempt(() =>
            operation.kind === "navigate"
              ? allowedBrowserUrl(
                  operation.url,
                  record.hosts,
                  record.unrestricted
                )
              : undefined
          )
          if (!destination && !record.session)
            return yield* new BrowserFailure({ message: "Open a page first." })
          const now = yield* Clock.currentTimeMillis
          if (record.session && browserDeadline(record.session) <= now) {
            yield* this.repository
              .reset(generation, record.hosts, record.unrestricted)
              .pipe(Effect.andThen(this.wake()), Effect.uninterruptible)
            return yield* new BrowserFailure({
              message:
                "This browser session expired. Reopen the page to start a fresh session.",
            })
          }
          if (
            operation.kind === "interact" &&
            (record.status !== "ready" ||
              operation.version !== record.version ||
              !record.capture ||
              now - record.capture.page.capturedAt > 60000)
          )
            return yield* new BrowserFailure({
              message:
                "The page view changed or is older than one minute. Refresh it before interacting.",
            })
          record = yield* this.repository.atomic(() =>
            Effect.gen({ self: this }, function* () {
              yield* check()
              const value = yield* this.repository.update(generation, {
                status: "loading",
                error: null,
                session: record.session
                  ? { ...record.session, idleExpiresAt: now + BROWSER_IDLE_MS }
                  : null,
              })
              started = true
              return value
            })
          )
          if (!record.session) {
            let adopted = false
            // Acquisition must finish so an otherwise orphaned session can be retired.
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
            const acquiredAt = yield* Clock.currentTimeMillis
            record = yield* this.repository
              .atomic(() =>
                Effect.gen({ self: this }, function* () {
                  yield* check()
                  const value = yield* this.repository.update(generation, {
                    session: {
                      ...session,
                      idleExpiresAt: acquiredAt + BROWSER_IDLE_MS,
                    },
                  })
                  adopted = true
                  return value
                })
              )
              .pipe(
                Effect.tap(() => this.wake()),
                Effect.uninterruptible
              )
          }
          yield* check()
          dispatched = true
          const capture: BrowserCapture = yield* destination
            ? this.driver.navigate(
                record.session!,
                destination,
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
          const completedAt = yield* Clock.currentTimeMillis
          return yield* this.repository.atomic(() =>
            Effect.gen({ self: this }, function* () {
              yield* check()
              const next = yield* this.repository.update(generation, {
                status: "ready",
                session: {
                  ...record.session!,
                  idleExpiresAt: completedAt + BROWSER_IDLE_MS,
                },
                capture,
                error: null,
              })
              return { ...capture, generation, version: next.version }
            })
          )
        })
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.failCause(
            Cause.map(cause, (reason) => {
              if (reason._tag === "BrowserStorageError") return reason
              error = failure(
                reason._tag === "BrowserFailure" ? reason : undefined
              )
              return error
            })
          )
        ),
        Effect.onExit((exit) =>
          Exit.isFailure(exit) && started
            ? this.repository
                .atomic(() =>
                  Effect.gen({ self: this }, function* () {
                    if (
                      (yield* this.repository.read()).generation === generation
                    )
                      yield* this.repository.update(generation, {
                        status: "error",
                        capture: null,
                        error: error?.message ?? interruptedMessage,
                      })
                  })
                )
                .pipe(orDieAll)
            : Effect.void
        )
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
          const current = yield* this.repository.read()
          if (
            current.session &&
            (browserDeadline(current.session) <= now ||
              !(yield* this.writable()))
          )
            yield* this.repository.reset(
              current.generation,
              current.hosts,
              current.unrestricted
            )
        })
      )
      let retry = false
      for (const id of yield* this.repository.retired()) {
        const closed = yield* this.driver.close(id).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Cause.hasDies(cause) || Cause.hasInterrupts(cause)
              ? Effect.failCause(cause).pipe(orDieAll)
              : Effect.succeed(false)
          )
        )
        if (closed) yield* this.repository.forget(id)
        else retry = true
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
