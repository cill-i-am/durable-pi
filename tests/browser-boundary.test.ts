import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import { Harness, createRegistry } from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai"
import { browserTools } from "../src/browser/adapters/tools"
import { expect, it } from "vitest"
import { it as effectIt } from "@effect/vitest"
import {
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
} from "effect"
import { TestClock } from "effect/testing"
import { database } from "./database"
import type { Sqlite } from "../src/storage/sqlite"
import {
  Browser,
  BrowserWorkspace,
  browserApplication,
} from "../src/browser/browser"
import { BrowserStore } from "../src/browser/adapters/sqlite"
import {
  effectBrowserDriver,
  browserWake,
  type ForeignBrowserDriver,
} from "../src/browser/adapters/interop"
import { orDieAll } from "../src/shared/effect"
import { browserRequest } from "../src/browser/adapters/http"
import { browserToolResult } from "../src/browser/adapters/pi"
import { BrowserFailure } from "../src/browser/contracts"
import { BrowserUnavailable, type BrowserDriver } from "../src/browser/driver"

const capture = {
  page: {
    url: "https://example.com/",
    title: "Synthetic",
    text: "Untrusted page",
    links: [],
    capturedAt: 1000,
  },
  screenshot: null,
}
const session = {
  id: "private-browser-session",
  targetId: "private-target",
  expiresAt: 601000,
}
function gate() {
  let release!: () => void
  const waiting = new Promise<void>((done) => {
    release = done
  })
  return { waiting, release }
}
function fixture(db = database()) {
  const ledger = new BrowserStore(db),
    state = { writable: true, wakes: 0 },
    closed: string[] = []
  const driver: BrowserDriver = {
    open: () => Effect.succeed(session),
    navigate: () =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => ({
          ...capture,
          page: { ...capture.page, capturedAt: now },
        }))
      ),
    capture: () => Effect.succeed(capture),
    interact: () => Effect.succeed(capture),
    close: (id) =>
      Effect.sync(() => {
        closed.push(id)
      }),
  }
  const wake = () =>
    Effect.sync(() => {
      state.wakes++
    })
  const browser = new BrowserWorkspace(
    ledger,
    driver,
    () => state.writable,
    wake
  )
  return { ledger, driver, db, state, closed, wake, browser }
}

effectIt.effect(
  "browser invocation Clock owns observation freshness, idle expiry, absolute expiry and cleanup backoff",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      yield* TestClock.setTime(1000)
      const view = yield* f.browser.inspect(0, "https://example.com")
      expect(view.page.capturedAt).toBe(1000)
      expect(f.ledger.read().session).toMatchObject({
        expiresAt: 601000,
        idleExpiresAt: 121000,
      })
      yield* TestClock.setTime(61001)
      expect(
        yield* f.browser
          .interact(
            {
              generation: 0,
              version: view.version,
              action: { kind: "click", x: 1, y: 1 },
            },
            "agent"
          )
          .pipe(Effect.result)
      ).toMatchObject({ _tag: "Failure", failure: { outcome: "rejected" } })
      yield* f.browser.inspect(0)
      expect(f.ledger.read().session).toMatchObject({
        expiresAt: 601000,
        idleExpiresAt: 181001,
      })
      yield* TestClock.setTime(181002)
      expect((yield* f.browser.state()).status).toBe("expired")
      f.driver.close = () => Effect.fail(new BrowserUnavailable())
      expect(yield* f.browser.cleanup()).toBe(211002)
      expect(f.ledger.read().session).toBeNull()
      expect(f.ledger.retired()).toEqual([session.id])
      f.driver.close = (id) =>
        Effect.sync(() => {
          f.closed.push(id)
        })
      expect(yield* f.browser.cleanup()).toBeUndefined()
      expect(f.closed).toEqual([session.id])
    })
)

it("native reset atomically rolls back retirement and generation on a failed commit, without waking cleanup", async () => {
  const native = database()
  let fail = false
  const db: Sqlite = {
    all: native.all,
    run: native.run,
    transaction: (change) =>
      native.transaction(() => {
        const value = change()
        if (fail) throw new Error("Private commit failure")
        return value
      }),
  }
  const f = fixture(db)
  f.ledger.update(0, {
    session: { ...session, expiresAt: Date.now() + 600000 },
  })
  const before = f.ledger.read()
  fail = true
  expect(
    await Effect.runPromise(f.browser.close(0).pipe(Effect.result))
  ).toMatchObject({ _tag: "Failure", failure: { _tag: "BrowserStorageError" } })
  expect(f.ledger.read()).toEqual(before)
  expect(f.ledger.retired()).toEqual([])
  expect(f.state.wakes).toBe(0)
  fail = false
  expect(() =>
    f.ledger.atomic(() => {
      throw new TypeError("Callback defect")
    })
  ).toThrow(TypeError)
  await Effect.runPromise(f.browser.close(0))
  expect(f.ledger.read()).toMatchObject({ generation: 1, session: null })
  expect(f.ledger.retired()).toEqual([session.id])
  expect(f.state.wakes).toBe(1)
})

it("historical codecs preserve restricted defaults, reject corrupt records as defects, and keep SQL failures typed at HTTP", async () => {
  const f = fixture(),
    legacy = f.ledger.read()
  f.db.run(
    "INSERT INTO bot_browser VALUES (1,?)",
    JSON.stringify({
      ...legacy,
      controller: undefined,
      unrestricted: undefined,
    })
  )
  expect(f.ledger.read()).toMatchObject({
    controller: "agent",
    unrestricted: false,
  })
  f.db.run(
    "UPDATE bot_browser SET record=?",
    JSON.stringify({ ...legacy, generation: -1 })
  )
  const corrupt = await Effect.runPromiseExit(
    browserRequest(
      f.browser,
      new Request("https://app.test/browser"),
      "browser"
    )
  )
  expect(Exit.isFailure(corrupt) && Cause.hasDies(corrupt.cause)).toBe(true)
  const native = database(),
    db: Sqlite = {
      run: native.run,
      transaction: native.transaction,
      all: () => {
        throw new Error("Private driver details")
      },
    }
  const offline = fixture(db)
  expect(
    await Effect.runPromise(offline.browser.state().pipe(Effect.result))
  ).toMatchObject({ _tag: "Failure", failure: { _tag: "BrowserStorageError" } })
  const response = await Effect.runPromise(
    browserRequest(
      offline.browser,
      new Request("https://app.test/browser"),
      "browser"
    )
  )
  expect(response.status).toBe(409)
  expect(await response.text()).not.toContain("Private driver details")
})

it("actor disposal joins late browser acquisition, durably retires it and wakes cleanup before closing Layers", async () => {
  const entered = gate(),
    opened = gate(),
    events: string[] = [],
    ledger = new BrowserStore(database())
  let navigations = 0
  const native: ForeignBrowserDriver = {
    open: async () => {
      entered.release()
      await opened.waiting
      events.push("open.settled")
      return { ...session, expiresAt: Date.now() + 600000 }
    },
    navigate: async () => {
      navigations++
      return capture
    },
    capture: async () => capture,
    interact: async () => capture,
    close: async (id) => {
      events.push(`close:${id}`)
    },
  }
  const driver = effectBrowserDriver(native),
    wake = browserWake(async () => {
      events.push("wake")
    })
  const actor = ManagedRuntime.make(
    Layer.mergeAll(
      browserApplication(ledger, driver, () => true, wake),
      Layer.effectDiscard(
        Effect.addFinalizer(() =>
          Effect.sync(() => {
            events.push("layer.closed")
          })
        )
      )
    )
  )
  const work = actor.runPromiseExit(
    Effect.flatMap(Browser, (browser) =>
      browser.inspect(0, "https://example.com")
    )
  )
  await entered.waiting
  let disposed = false
  const dispose = actor.dispose().then(() => {
    disposed = true
  })
  await Promise.resolve()
  expect(disposed).toBe(false)
  expect(events).not.toContain("layer.closed")
  opened.release()
  const exit = await work
  await dispose
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(navigations).toBe(0)
  expect(ledger.retired()).toEqual([session.id])
  expect(events.indexOf("wake")).toBeLessThan(events.indexOf("layer.closed"))
  const restored = new BrowserWorkspace(ledger, driver, () => true, wake)
  await Effect.runPromise(restored.recover())
  await Effect.runPromise(restored.cleanup())
  expect(ledger.retired()).toEqual([])
  expect(
    events.filter((event) => event === `close:${session.id}`)
  ).toHaveLength(1)
})

it("interrupted native navigation settles under the tab permit and cannot publish a late capture", async () => {
  const entered = gate(),
    finish = gate(),
    abort = new AbortController(),
    f = fixture()
  let settled = false
  f.ledger.update(0, {
    session: { ...session, expiresAt: Date.now() + 600000 },
  })
  const driver = effectBrowserDriver({
    open: async () => session,
    capture: async () => capture,
    interact: async () => capture,
    close: async () => {},
    navigate: async () => {
      entered.release()
      await finish.waiting
      return capture
    },
  })
  const browser = new BrowserWorkspace(f.ledger, driver, () => true, f.wake)
  const work = Effect.runPromiseExit(
    browser.inspect(0, "https://example.com"),
    { signal: abort.signal }
  ).then((exit) => {
    settled = true
    return exit
  })
  await entered.waiting
  abort.abort()
  await Promise.resolve()
  expect(settled).toBe(false)
  finish.release()
  const exit = await work
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(f.ledger.read()).toMatchObject({ status: "error", capture: null })
  expect(f.ledger.read().error).toContain("may have run")
})

it("browser tool projection preserves requirements and caller Context, and driver programming defects remain defects", async () => {
  class Invocation extends Context.Service<Invocation, string>()(
    "BrowserInvocation"
  ) {}
  const result = await Effect.runPromise(
    browserToolResult(
      Effect.gen(function* () {
        const marker = yield* Invocation
        return {
          ...capture,
          page: { ...capture.page, title: marker },
          generation: 0,
          version: 1,
        }
      })
    ).pipe(Effect.provideService(Invocation, "caller context"))
  )
  expect(result.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("caller context"),
  })
  const f = fixture()
  const native: ForeignBrowserDriver = {
    open: async () => {
      throw new TypeError("Private programming failure")
    },
    navigate: async () => capture,
    capture: async () => capture,
    interact: async () => capture,
    close: async () => {},
  }
  const browser = new BrowserWorkspace(
    f.ledger,
    effectBrowserDriver(native),
    () => true,
    f.wake
  )
  const exit = await Effect.runPromiseExit(
    browserRequest(
      browser,
      new Request("https://app.test/browser/open", {
        method: "POST",
        body: JSON.stringify({ generation: 0, url: "https://example.com" }),
      }),
      "browser/open"
    )
  )
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
})

it("native Pi browser tools share the retained actor Context and SDK signal without exposing provider session identities", async () => {
  class Invocation extends Context.Service<Invocation, string>()(
    "BrowserNativeToolInvocation"
  ) {}
  const f = fixture(),
    directory = await mkdtemp(join(tmpdir(), "pi-browser-tools-"))
  f.driver.open = () =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => ({ ...session, expiresAt: now + 600000 }))
    )
  const actor = ManagedRuntime.make(Layer.succeed(Invocation, "tool caller")),
    seen: { context: string; activeSignal: boolean; value: unknown }[] = []
  const registry = createRegistry()
  registry.install({
    name: "browser",
    tools: browserTools(f.browser, (program, options) =>
      actor.runPromise(
        Effect.gen(function* () {
          const context = yield* Invocation,
            activeSignal =
              options?.signal !== undefined && !options.signal.aborted
          const value = yield* program
          seen.push({ context, activeSignal, value })
          return value
        }),
        options
      )
    ),
  })
  const faux = fauxProvider({ tokensPerSecond: 100000 }),
    models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(
        "browser_open",
        { url: "https://example.com" },
        { id: "open" }
      ),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage(fauxToolCall("browser_read", {}, { id: "read" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Read the page."),
  ])
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(directory, "pi.sqlite")),
    {
      models,
      registry,
      settings: { compaction: { enabled: false }, retry: { enabled: false } },
    },
    ctx
  )
  try {
    const conversation = await harness.root(ctx, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    })
    const command = {
      type: "input" as const,
      requestId: crypto.randomUUID(),
      content: [
        { type: "text" as const, text: "Open and read the synthetic page." },
      ],
    }
    const turn = await conversation.submit(command, ctx)
    await turn.wait(ctx)
    await conversation.waitForIdle(ctx)
    expect(seen).toHaveLength(2)
    expect(
      seen.every(
        (entry) => entry.context === "tool caller" && entry.activeSignal
      )
    ).toBe(true)
    expect(JSON.stringify(seen)).toContain("Untrusted page")
    expect(JSON.stringify(seen)).not.toContain(session.id)
    expect(JSON.stringify(seen)).not.toContain(session.targetId)
    expect((await conversation.submit(command, ctx)).id).toBe(turn.id)
    expect(seen).toHaveLength(2)
  } finally {
    await harness.close(ctx)
    await actor.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 15000)

it.each(["defect", "interruption"])(
  "does not recover a browser rejection combined with %s at tool or HTTP boundaries",
  async (mode) => {
    const f = fixture(),
      cleanupFailure = new Error("Private cleanup failure")
    f.driver.open = () =>
      Effect.fail(
        new BrowserFailure({
          outcome: "rejected",
          message: "Known browser rejection",
        })
      ).pipe(
        Effect.ensuring(
          mode === "defect" ? Effect.die(cleanupFailure) : Effect.interrupt
        )
      )
    const tool = await Effect.runPromiseExit(
      browserToolResult(f.browser.inspect(0, "https://example.com"))
    )
    expect(Exit.isFailure(tool)).toBe(true)
    expect(
      Exit.isFailure(tool) &&
        (mode === "defect"
          ? Cause.hasDies(tool.cause)
          : Cause.hasInterrupts(tool.cause))
    ).toBe(true)
    if (mode === "defect")
      expect(
        Exit.isFailure(tool) &&
          tool.cause.reasons.some(
            (reason) =>
              reason._tag === "Die" && reason.defect === cleanupFailure
          )
      ).toBe(true)
    const http = await Effect.runPromiseExit(
      browserRequest(
        f.browser,
        new Request("https://app.test/browser/open", {
          method: "POST",
          body: JSON.stringify({ generation: 0, url: "https://example.com" }),
        }),
        "browser/open"
      )
    )
    expect(Exit.isFailure(http)).toBe(true)
    if (mode === "defect")
      expect(
        Exit.isFailure(http) &&
          http.cause.reasons.some(
            (reason) =>
              reason._tag === "Die" && reason.defect === cleanupFailure
          )
      ).toBe(true)
    expect(
      Exit.isFailure(http) &&
        (mode === "defect"
          ? Cause.hasDies(http.cause)
          : Cause.hasInterrupts(http.cause))
    ).toBe(true)
  }
)

it("keeps a retired session ticket and cleanup defects when a transport failure accompanies failed release", async () => {
  const f = fixture()
  f.ledger.retire(session.id)
  f.driver.close = () =>
    Effect.fail(new BrowserUnavailable()).pipe(
      Effect.ensuring(Effect.die(new Error("Private cleanup failure")))
    )
  const exit = await Effect.runPromiseExit(f.browser.cleanup())
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(f.ledger.retired()).toEqual([session.id])
})

it("fatal browser conversion preserves every typed failure, defect and interruption reason", async () => {
  const first = Cause.makeFailReason(
      new BrowserFailure({ message: "Known rejection" })
    ),
    second = Cause.makeFailReason(new BrowserUnavailable()),
    defect = Cause.makeDieReason(new Error("Private cleanup failure")),
    interrupted = Cause.makeInterruptReason(123)
  const cause = Cause.fromReasons<BrowserFailure | BrowserUnavailable>([
    first,
    second,
    defect,
    interrupted,
  ])
  const exit = await Effect.runPromiseExit(
    Effect.failCause(cause).pipe(orDieAll)
  )
  expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(Exit.isFailure(exit) && exit.cause.reasons).toContain(defect)
  expect(Exit.isFailure(exit) && exit.cause.reasons).toContain(interrupted)
  expect(
    Exit.isFailure(exit) &&
      exit.cause.reasons
        .filter((reason) => reason._tag === "Die")
        .map((reason) => reason.defect)
  ).toEqual([first, second, defect.defect])
})
