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
} from "./contracts"

export interface BrowserRepository {
  read: () => BrowserRecord
  update: (
    generation: number,
    patch: Partial<
      Pick<BrowserRecord, "status" | "session" | "capture" | "error">
    >
  ) => BrowserRecord
  reset: (generation: number, hosts: readonly string[]) => BrowserRecord
  retire: (id: string) => void
  retired: () => string[]
  forget: (id: string) => void
}
export interface BrowserDriver {
  open: (hosts: readonly string[]) => Promise<BrowserSession>
  navigate: (
    session: BrowserSession,
    url: string,
    hosts: readonly string[]
  ) => Promise<BrowserCapture>
  capture: (
    session: BrowserSession,
    hosts: readonly string[]
  ) => Promise<BrowserCapture>
  close: (id: string) => Promise<void>
}

/** The bot owns session identity, revocation, and recovery; the driver owns Chromium. */
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
          this.repository.reset(policy.generation, [...new Set(policy.hosts)])
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
        this.repository.reset(generation, this.repository.read().hosts)
      )
      yield* Effect.promise(this.wake)
      return this.state()
    })
  }
  inspect(generation: number, url?: string, signal?: AbortSignal) {
    const check = () => {
      this.check(generation)
      if (signal?.aborted)
        throw new BrowserFailure({
          message: "This browser action was stopped.",
        })
    }
    return this.operations.withPermit(
      // Cancellation cannot release tab ownership while Chromium still runs.
      // The explicit signal fences dispatch/publication; driver calls have bounded timeouts.
      Effect.uninterruptible(
        Effect.tryPromise({
          try: async () => {
            check()
            let record = this.repository.read()
            const destination =
              url === undefined
                ? undefined
                : allowedBrowserUrl(url, record.hosts)
            if (!record.hosts.length)
              throw new BrowserFailure({
                message: "Add allowed sites in Browser before browsing.",
              })
            if (!destination && !record.session)
              throw new BrowserFailure({ message: "Open a page first." })
            if (
              record.session &&
              browserDeadline(record.session) <= Date.now()
            ) {
              this.repository.reset(generation, record.hosts)
              await this.wake()
              throw new BrowserFailure({
                message:
                  "This browser session expired. Reopen the page to start a fresh session.",
              })
            }
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
                const session = await this.driver.open(record.hosts)
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
              const capture = destination
                ? await this.driver.navigate(
                    record.session!,
                    destination,
                    record.hosts
                  )
                : await this.driver.capture(record.session!, record.hosts)
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
              return capture
            } catch (cause) {
              if (this.repository.read().generation === generation)
                this.repository.update(generation, {
                  status: "error",
                  error:
                    cause instanceof BrowserFailure
                      ? cause.message
                      : "The browser could not finish. It may have expired. Close it and open the page again.",
                })
              throw cause
            }
          },
          catch: (cause) =>
            cause instanceof BrowserFailure
              ? cause
              : new BrowserFailure({
                  message:
                    "The browser could not finish. It may have expired. Close it and open the page again.",
                }),
        })
      )
    )
  }
  cleanup() {
    return Effect.tryPromise(async () => {
      const current = this.repository.read()
      if (
        current.session &&
        (browserDeadline(current.session) <= Date.now() || !this.writable())
      )
        this.repository.reset(current.generation, current.hosts)
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
