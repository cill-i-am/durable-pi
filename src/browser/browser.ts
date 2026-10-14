import { Effect, Semaphore } from "effect"
import {
  BrowserFailure,
  allowedBrowserUrl,
  browserState,
  browserDeadline,
  BROWSER_IDLE_MS,
  type BrowserRecord,
  type BrowserSession,
  type BrowserCapture,
  type BrowserPolicy,
  type BrowserController,
  type BrowserAction,
  type BrowserInteraction,
} from "./contracts"

export interface BrowserRepository {
  read: () => BrowserRecord
  update: (
    generation: number,
    patch: Partial<
      Pick<BrowserRecord, "status" | "session" | "capture" | "error">
    >
  ) => BrowserRecord
  reset: (
    generation: number,
    hosts: readonly string[],
    unrestricted?: boolean
  ) => BrowserRecord
  transfer: (generation: number, controller: BrowserController) => BrowserRecord
  retire: (id: string) => void
  retired: () => string[]
  forget: (id: string) => void
}
export interface BrowserDriver {
  open: (
    hosts: readonly string[],
    unrestricted?: boolean
  ) => Promise<BrowserSession>
  navigate: (
    session: BrowserSession,
    url: string,
    hosts: readonly string[],
    unrestricted?: boolean
  ) => Promise<BrowserCapture>
  capture: (
    session: BrowserSession,
    hosts: readonly string[],
    unrestricted?: boolean
  ) => Promise<BrowserCapture>
  interact: (
    session: BrowserSession,
    action: BrowserAction,
    expectedUrl: string,
    hosts: readonly string[],
    actor: BrowserController,
    unrestricted?: boolean
  ) => Promise<BrowserCapture>
  close: (id: string) => Promise<void>
}

export class BrowserWorkspace {
  private readonly operations = Semaphore.makeUnsafe(1)
  constructor(
    readonly repository: BrowserRepository,
    readonly driver: BrowserDriver,
    private readonly writable: () => boolean,
    private readonly wake: () => Promise<void>
  ) {}
  state() {
    return browserState(this.repository.read())
  }
  private check(generation: number) {
    if (!this.writable())
      throw new BrowserFailure({ message: "This bot is archived." })
    if (this.repository.read().generation !== generation)
      throw new BrowserFailure({
        message: "Browser settings changed. Reload before continuing.",
      })
  }
  configure(policy: BrowserPolicy) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.try({
        try: () => {
          this.check(policy.generation)
          this.repository.reset(
            policy.generation,
            [...new Set(policy.hosts)],
            policy.unrestricted ?? false
          )
        },
        catch: (cause) => cause,
      })
      yield* Effect.promise(this.wake)
      return this.state()
    })
  }
  close(generation: number) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.try(() =>
        this.repository.reset(
          generation,
          this.repository.read().hosts,
          this.repository.read().unrestricted
        )
      )
      yield* Effect.promise(this.wake)
      return this.state()
    })
  }
  control(generation: number, controller: BrowserController) {
    return Effect.gen({ self: this }, function* () {
      const record = yield* Effect.try(() => {
        this.check(generation)
        const current = this.repository.read()
        if (!current.session || browserDeadline(current.session) <= Date.now())
          throw new BrowserFailure({
            message: "Open a page before taking control.",
          })
        return this.repository.transfer(generation, controller)
      })
      yield* this.inspect(record.generation, undefined, undefined, "owner")
      return this.state()
    })
  }
  recover() {
    const record = this.repository.read()
    if (record.status === "loading")
      this.repository.update(record.generation, {
        status: "error",
        capture: null,
        error:
          "The browser operation was interrupted and may have run. Inspect the page before trying again.",
      })
  }
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
    let dispatched = false
    const failure = (cause: unknown) =>
      new BrowserFailure({
        message:
          cause instanceof BrowserFailure
            ? cause.message
            : dispatched && operation.kind === "inspect"
              ? "The browser page could not be read. Refresh its view; if the session expired, close it and open a page again."
              : dispatched
                ? "The browser operation could not finish and may have run. Inspect the page before trying again, or close an expired session."
                : "The browser service could not open a session. Try opening a page again; if this persists, check Cloudflare Browser Run.",
        outcome:
          cause instanceof BrowserFailure && cause.outcome
            ? cause.outcome
            : !dispatched || operation.kind === "inspect"
              ? "rejected"
              : "uncertain",
      })
    const check = () => {
      this.check(generation)
      const controller = this.repository.read().controller
      if (actor === "agent" && controller === "owner")
        throw new BrowserFailure({
          message:
            "The owner has browser control. Wait for them to return control before using browser tools.",
        })
      if (
        operation.kind === "interact" &&
        actor === "owner" &&
        controller !== "owner"
      )
        throw new BrowserFailure({
          message: "Take control before interacting with this page.",
        })
      if (signal?.aborted)
        throw new BrowserFailure({
          message: "This browser action was stopped.",
        })
    }
    const action = this.operations.withPermit(
      Effect.uninterruptible(
        Effect.tryPromise({
          try: async () => {
            dispatched = false
            check()
            let record = this.repository.read()
            if (!record.unrestricted && !record.hosts.length)
              throw new BrowserFailure({
                message:
                  "Add allowed sites or enable unrestricted internet in Browser settings before browsing.",
              })
            const destination =
              operation.kind === "navigate"
                ? allowedBrowserUrl(
                    operation.url,
                    record.hosts,
                    record.unrestricted
                  )
                : undefined
            if (!destination && !record.session)
              throw new BrowserFailure({ message: "Open a page first." })
            if (
              record.session &&
              browserDeadline(record.session) <= Date.now()
            ) {
              this.repository.reset(
                generation,
                record.hosts,
                record.unrestricted
              )
              await this.wake()
              throw new BrowserFailure({
                message:
                  "This browser session expired. Reopen the page to start a fresh session.",
              })
            }
            if (
              operation.kind === "interact" &&
              (record.status !== "ready" ||
                operation.version !== record.version ||
                !record.capture ||
                Date.now() - record.capture.page.capturedAt > 60_000)
            )
              throw new BrowserFailure({
                message:
                  "The page view changed or is older than one minute. Refresh it before interacting.",
              })
            record = this.repository.update(generation, {
              status: "loading",
              error: null,
              session: record.session
                ? {
                    ...record.session,
                    idleExpiresAt: Date.now() + BROWSER_IDLE_MS,
                  }
                : null,
            })
            try {
              if (!record.session) {
                const session = await this.driver.open(
                  record.hosts,
                  record.unrestricted
                )
                try {
                  check()
                  record = this.repository.update(generation, {
                    session: {
                      ...session,
                      idleExpiresAt: Date.now() + BROWSER_IDLE_MS,
                    },
                  })
                } catch (cause) {
                  this.repository.retire(session.id)
                  await this.wake()
                  throw cause
                }
                await this.wake()
              }
              check()
              dispatched = true
              const capture = destination
                ? await this.driver.navigate(
                    record.session!,
                    destination,
                    record.hosts,
                    record.unrestricted
                  )
                : operation.kind === "interact"
                  ? await this.driver.interact(
                      record.session!,
                      operation.action,
                      record.capture!.page.url,
                      record.hosts,
                      actor,
                      record.unrestricted
                    )
                  : await this.driver.capture(
                      record.session!,
                      record.hosts,
                      record.unrestricted
                    )
              check()
              this.repository.update(generation, {
                status: "ready",
                session: {
                  ...record.session!,
                  idleExpiresAt: Date.now() + BROWSER_IDLE_MS,
                },
                capture,
                error: null,
              })
              return {
                ...capture,
                generation,
                version: this.repository.read().version,
              }
            } catch (cause) {
              const error = failure(cause)
              if (this.repository.read().generation === generation)
                this.repository.update(generation, {
                  status: "error",
                  capture: null,
                  error: error.message,
                })
              throw error
            }
          },
          catch: failure,
        })
      )
    )
    return action.pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Browser.operationFailed").pipe(
          Effect.annotateLogs({
            operation: operation.kind,
            outcome: error.outcome,
            message: error.message,
          })
        )
      ),
      Effect.withSpan("Browser.perform", {
        attributes: { "browser.operation": operation.kind },
      })
    )
  }
  cleanup() {
    return Effect.tryPromise(async () => {
      const current = this.repository.read()
      if (
        current.session &&
        (browserDeadline(current.session) <= Date.now() || !this.writable())
      )
        this.repository.reset(
          current.generation,
          current.hosts,
          current.unrestricted
        )
      let retry = false
      for (const id of this.repository.retired()) {
        try {
          await this.driver.close(id)
          this.repository.forget(id)
        } catch {
          retry = true
        }
      }
      const session = this.repository.read().session
      const deadline = session ? browserDeadline(session) : undefined
      return retry
        ? Math.min(Date.now() + 30_000, deadline ?? Infinity)
        : deadline
    })
  }
}
