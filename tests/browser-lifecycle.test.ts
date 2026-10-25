import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { expect, it } from "vitest"

import { BrowserStore } from "../src/browser/adapters/sqlite"
import { BrowserWorkspace } from "../src/browser/browser"
import { BrowserFailure } from "../src/browser/contracts"
import { initialBrowser } from "../src/browser/domain"
import type { BrowserDriver } from "../src/browser/driver"
import { runBrowserOperation } from "../src/browser/operation"
import { restoreBrowserRecord } from "../src/browser/record"
import { retireBrowser } from "../src/browser/retirement"
import {
  advanceBrowser,
  type BrowserEvent,
} from "../src/browser/session.machine"
import { database, type TestSqlite } from "./database"
import { sqliteFailure } from "./sqlite-fault"

const capture = {
  page: {
    url: "https://example.com/",
    title: "Synthetic",
    text: "Synthetic page",
    links: [],
    capturedAt: Date.now(),
  },
  screenshot: "synthetic",
}
const session = {
  id: "retained-session",
  targetId: "retained-target",
  expiresAt: Date.now() + 600000,
}

it.each([false, true])(
  "fences a late browser result after durable recovery (new capture: %s)",
  async (replace) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = new BrowserStore(database())
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const driver: BrowserDriver = {
            open: () => Effect.succeed(session),
            navigate: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(capture)
              ),
            capture: () => Effect.succeed(capture),
            interact: () => Effect.succeed(capture),
            close: () => Effect.void,
          }
          const make = () =>
            new BrowserWorkspace(
              ledger,
              driver,
              () => Effect.succeed(true),
              () => Effect.void
            )
          const original = make()
          const pending = yield* original
            .inspect(0, "https://example.com")
            .pipe(Effect.exit, Effect.forkScoped)
          yield* Deferred.await(entered)
          const restored = make()
          yield* restored.recover()
          if (replace) yield* restored.inspect(0)
          yield* Deferred.succeed(release, undefined)
          const result = yield* Fiber.join(pending)
          expect(result._tag).toBe("Failure")
          expect(yield* restored.state()).toMatchObject({
            status: replace ? "ready" : "error",
            page: replace ? capture.page : null,
            hasScreenshot: replace,
          })
        })
      )
    )
  }
)

it("admits only one browser attempt across independently reconstructed hosts", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const ledger = new BrowserStore(database())
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let calls = 0
        const driver: BrowserDriver = {
          open: () => Effect.succeed(session),
          navigate: () =>
            Effect.sync(() => ++calls).pipe(
              Effect.flatMap((number) =>
                number === 1
                  ? Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.as(capture)
                    )
                  : Effect.succeed(capture)
              )
            ),
          capture: () => Effect.succeed(capture),
          interact: () => Effect.succeed(capture),
          close: () => Effect.void,
        }
        const make = () =>
          new BrowserWorkspace(
            ledger,
            driver,
            () => Effect.succeed(true),
            () => Effect.void
          )
        const first = yield* make()
          .inspect(0, "https://example.com")
          .pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        expect(
          yield* make()
            .inspect(0, "https://example.com/next")
            .pipe(Effect.result)
        ).toMatchObject({ _tag: "Failure", failure: { outcome: "rejected" } })
        expect(calls).toBe(1)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(first)
      })
    )
  )
})

it("migrates legacy loading data in place without replay and rejects future versions", async () => {
  const db = database()
  const legacy = {
    ...initialBrowser(),
    status: "loading",
    session,
    capture,
    version: 7,
    schemaVersion: undefined,
    workflowVersion: undefined,
    attemptId: undefined,
  }
  db.run("INSERT INTO bot_browser VALUES (1,?)", JSON.stringify(legacy))
  const ledger = new BrowserStore(db)
  const before = Effect.runSync(ledger.read())
  expect(before).toMatchObject({
    schemaVersion: 1,
    workflowVersion: 1,
    attemptId: "legacy:0:7",
    session,
    capture,
  })
  const recovered = await Effect.runPromise(ledger.advance({ type: "RECOVER" }))
  expect(recovered).toMatchObject({
    status: "error",
    attemptId: null,
    session,
    capture: null,
    version: 8,
  })
  expect(Effect.runSync(new BrowserStore(db).read())).toEqual(recovered)
  for (const key of ["schemaVersion", "workflowVersion"])
    expect(() => restoreBrowserRecord({ ...recovered, [key]: 99 })).toThrow()
  expect(() =>
    restoreBrowserRecord({ ...legacy, workflowVersion: 1 })
  ).toThrow()
})

it("rejects malformed machine events and fences same-generation stale ownership", () => {
  const original = initialBrowser()
  const event: BrowserEvent = {
    type: "BEGIN",
    generation: 0,
    attemptId: "first",
    kind: "navigate",
    version: null,
    actor: "agent",
    now: 1000,
  }
  expect(() =>
    advanceBrowser(original, {
      ...event,
      kind: "unknown",
    } as unknown as BrowserEvent)
  ).toThrow()
  const pending = advanceBrowser(original, event)
  expect(() =>
    advanceBrowser(pending, {
      type: "ADOPT",
      generation: 0,
      attemptId: "old",
      session,
      now: 1000,
    })
  ).toThrow("superseded")
  expect(
    advanceBrowser(pending, {
      type: "FAILED",
      generation: 0,
      attemptId: "old",
      message: "Old cleanup",
    })
  ).toEqual(pending)
  const recovered = advanceBrowser(pending, { type: "RECOVER" })
  expect(() =>
    advanceBrowser(recovered, {
      type: "CAPTURED",
      generation: 0,
      attemptId: "first",
      session,
      capture,
      now: 1001,
    })
  ).toThrow("superseded")
})

it("joins interrupted browser invocation cleanup and retains its complete late cause", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const cleaning = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const failure = Cause.makeFailReason(
          new BrowserFailure({ message: "Late transport failure" })
        )
        const defect = Cause.makeDieReason(new Error("Late cleanup defect"))
        let published = false
        const pending = yield* runBrowserOperation<BrowserFailure>({
          admit: Effect.succeed({ ...initialBrowser(), session }),
          acquire: () => Effect.die("Unexpected acquisition"),
          dispatch: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Deferred.succeed(cleaning, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(
                    Effect.failCause(
                      Cause.fromReasons<never>([
                        Cause.makeDieReason(failure),
                        defect,
                      ])
                    )
                  )
                )
              )
            ),
          publish: () =>
            Effect.sync(() => {
              published = true
              return { ...capture, generation: 0, version: 1 }
            }),
        }).pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        let settled = false
        const interrupting = yield* Fiber.interrupt(pending).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              settled = true
            })
          ),
          Effect.forkScoped
        )
        yield* Deferred.await(cleaning)
        expect(settled).toBe(false)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(interrupting)
        const exit = yield* Fiber.await(pending)
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(
          true
        )
        expect(
          Exit.isFailure(exit) &&
            exit.cause.reasons
              .filter((reason) => reason._tag === "Die")
              .map((reason) => reason.defect)
        ).toContain(failure)
        expect(
          Exit.isFailure(exit) &&
            exit.cause.reasons
              .filter((reason) => reason._tag === "Die")
              .map((reason) => reason.defect)
        ).toContain(defect.defect)
        expect(published).toBe(false)
      })
    )
  )
})

it("joins retirement acknowledgement cleanup and retains its late failure", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const cleaning = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const defect = new Error("Late acknowledgement cleanup defect")
        const pending = yield* retireBrowser(
          Effect.void,
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Deferred.succeed(cleaning, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.die(defect))
              )
            )
          )
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        let settled = false
        const interrupting = yield* Fiber.interrupt(pending).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              settled = true
            })
          ),
          Effect.forkScoped
        )
        yield* Deferred.await(cleaning)
        expect(settled).toBe(false)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(interrupting)
        const exit = yield* Fiber.await(pending)
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(
          true
        )
        expect(
          Exit.isFailure(exit) &&
            exit.cause.reasons
              .filter((reason) => reason._tag === "Die")
              .map((reason) => reason.defect)
        ).toContain(defect)
      })
    )
  )
})

it("retains acquisition cleanup ownership until the session commit succeeds", async () => {
  const native = database()
  let rollback = false
  let depth = 0
  const db: TestSqlite = {
    ...native,
    transaction: (change) =>
      native.transaction(() =>
        Effect.suspend(() => {
          depth++
          return change().pipe(
            Effect.flatMap((value) => {
              if (rollback && depth === 1) {
                rollback = false
                return Effect.fail(
                  sqliteFailure("Synthetic adoption commit failure")
                )
              }
              return Effect.succeed(value)
            }),
            Effect.ensuring(
              Effect.sync(() => {
                depth--
              })
            )
          )
        })
      ),
  }
  const ledger = new BrowserStore(db)
  let calls = 0
  const closed: string[] = []
  const driver: BrowserDriver = {
    open: () =>
      Effect.sync(() => {
        rollback = true
        return session
      }),
    navigate: () =>
      Effect.sync(() => {
        calls++
        return capture
      }),
    capture: () => Effect.succeed(capture),
    interact: () => Effect.succeed(capture),
    close: (id) =>
      Effect.sync(() => {
        closed.push(id)
      }),
  }
  const browser = new BrowserWorkspace(
    ledger,
    driver,
    () => Effect.succeed(true),
    () => Effect.void
  )
  const exit = await Effect.runPromiseExit(
    browser.inspect(0, "https://example.com")
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(Effect.runSync(ledger.read()).session).toBeNull()
  expect(Effect.runSync(ledger.retired())).toEqual([session.id])
  expect(calls).toBe(0)
  await Effect.runPromise(browser.cleanup())
  expect(closed).toEqual([session.id])
  expect(Effect.runSync(ledger.retired())).toEqual([])
})
