import { Cause, Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { BotConfigurationStore } from "../src/agents/adapters/configuration"
import { configureAgent } from "../src/agents/application"
import { type ConfigurationLedger } from "../src/agents/configuration"
import { homeAgentId } from "../src/agents/domain"
import {
  appConfiguration,
  invalidateArchivedApps,
} from "../src/apps/adapters/configuration"
import { AppStore } from "../src/apps/adapters/sqlite"
import {
  AppConflict,
  AppStorageError,
  type AppDocument,
  type InteractApp,
  type WebResult,
} from "../src/apps/contracts"
import { WebApps } from "../src/apps/web"
import type { CodeOutput } from "../src/execution/contracts"
import { nativeOperation } from "../src/shared/interop"
import { database } from "./database"

const profile = {
  id: homeAgentId,
  slug: "test",
  name: "Test",
  instructions: "Policy",
  status: "active" as const,
  revision: 0,
  createdAt: "2026-10-23T00:00:00.000Z",
  updatedAt: "2026-10-23T00:00:00.000Z",
}
const archived = { ...profile, status: "archived" as const, revision: 1 }
const restored = { ...profile, revision: 2 }
const output: WebResult = {
  html: "<p>Saved</p>",
  css: "",
  state: '{"count":1}',
  summary: "Added one.",
}
const click = (app: AppDocument): InteractApp => ({
  id: app.id,
  operationId: crypto.randomUUID(),
  version: app.publishedVersion!,
  expectedRevision: app.revision,
  action: { type: "web", blockId: "counter", name: "add", values: {} },
})
function fixture() {
  const db = database()
  const configuration = new BotConfigurationStore(db)
  const apps = new AppStore(db, () =>
    configuration.read().pipe(
      Effect.map((current) => current?.status !== "archived"),
      Effect.mapError(
        (cause) => new AppStorageError({ operation: "read authority", cause })
      )
    )
  )
  const composed = appConfiguration(db, configuration, apps)
  Effect.runSync(composed.configure("owner", profile))
  const draft = Effect.runSync(
    apps.save({
      id: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      expectedRevision: 0,
      definition: {
        title: "Counter",
        description: "Private counter",
        blocks: [
          {
            id: "counter",
            type: "web",
            code: "return {}",
            initialState: '{"count":0}',
          },
        ],
      },
    })
  )
  const app = Effect.runSync(
    apps.publish({
      id: draft.id,
      operationId: crypto.randomUUID(),
      expectedRevision: draft.revision,
      version: 1,
    })
  )
  return { db, configuration, apps, composed, app }
}
const currentApp = (f: ReturnType<typeof fixture>) =>
  Effect.runSync(f.apps.get(f.app.id))!
const pending = (f: ReturnType<typeof fixture>) =>
  Effect.runSync(f.apps.pending())

function synchronizationHost<E>(invalidate: () => Effect.Effect<void, E>) {
  return {
    invalidateApps: invalidate,
    syncTerminal: () => Effect.void,
    wakeBrowser: () => Effect.void,
    extractionPending: () => Effect.succeed(false),
    wakeExtraction: () => Effect.void,
    appsPending: () => Effect.succeed(false),
    wakeApps: () => Effect.void,
    routinesPending: () => Effect.succeed(false),
    wakeRoutines: () => Effect.void,
  }
}

/** The real synchronization machine reads after configuration has committed.
 * Restore can therefore win before that read and suppress local invalidation. */
function restoreBeforeSynchronizationRead(
  configuration: ConfigurationLedger
): ConfigurationLedger {
  return {
    ...configuration,
    configure: (owner, next) =>
      configuration
        .configure(owner, next)
        .pipe(Effect.andThen(configuration.configure(owner, restored))),
  }
}

describe("Apps configuration transaction", () => {
  it("cancels prearchive delivery when restore wins before local invalidation", async () => {
    const f = fixture()
    const input = click(f.app)
    const saved = Effect.runSync(f.apps.interact(input, output))
    const event = pending(f)[0]!
    let invalidations = 0
    await Effect.runPromise(
      configureAgent(
        restoreBeforeSynchronizationRead(f.composed),
        synchronizationHost(() =>
          Effect.sync(() => {
            invalidations++
          })
        )
      )("owner", archived)
    )
    expect(invalidations).toBe(0)
    expect(Effect.runSync(f.composed.read())).toMatchObject({
      revision: 2,
      status: "active",
    })
    expect(pending(f)).toEqual([])
    expect(Effect.runSync(f.apps.detail(f.app.id)).events).toEqual([
      expect.objectContaining({
        id: event.id,
        turnId: event.turnId,
        delivery: "cancelled",
      }),
    ])
    expect(currentApp(f)).toEqual({ ...saved, revision: saved.revision + 1 })
    expect(Effect.runSync(f.apps.interactionReceipt(input))).toEqual(saved)
    expect(Effect.runSync(f.apps.interact(input, output))).toEqual(saved)
  })

  it("rolls back bot archival, cancellation and app fencing when cancellation fails", () => {
    const f = fixture()
    const input = click(f.app)
    const saved = Effect.runSync(f.apps.interact(input, output))
    const event = pending(f)[0]
    f.db.run(
      "CREATE TRIGGER reject_app_cancellation BEFORE UPDATE ON generated_app_events BEGIN SELECT RAISE(ABORT,'cancellation failed'); END"
    )
    const result = Effect.runSync(
      f.composed.configure("owner", archived).pipe(Effect.result)
    )
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "AgentStorageError" },
    })
    expect(Effect.runSync(f.composed.read())).toMatchObject({
      revision: 0,
      status: "active",
    })
    expect(currentApp(f)).toEqual(saved)
    expect(pending(f)).toEqual([event])
    expect(Effect.runSync(f.apps.interactionReceipt(input))).toEqual(saved)
    f.db.run("DROP TRIGGER reject_app_cancellation")
    Effect.runSync(f.composed.configure("owner", archived))
    expect(pending(f)).toEqual([])
  })

  it("rolls back bot archival and event cancellation when the app revision write fails", () => {
    const f = fixture()
    const saved = Effect.runSync(f.apps.interact(click(f.app), output))
    const event = pending(f)[0]
    f.db.run(
      "CREATE TRIGGER reject_app_fence BEFORE UPDATE ON generated_apps BEGIN SELECT RAISE(ABORT,'fence failed'); END"
    )
    expect(
      Effect.runSync(
        f.composed.configure("owner", archived).pipe(Effect.result)
      )
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "AgentStorageError" },
    })
    expect(Effect.runSync(f.composed.read())).toMatchObject({
      revision: 0,
      status: "active",
    })
    expect(currentApp(f)).toEqual(saved)
    expect(pending(f)).toEqual([event])
  })

  it("leaves restored work and its revision intact on a stale archive profile", () => {
    const f = fixture()
    const saved = Effect.runSync(f.apps.interact(click(f.app), output))
    Effect.runSync(f.composed.configure("owner", archived))
    const fenced = currentApp(f)
    Effect.runSync(f.composed.configure("owner", archived))
    expect(currentApp(f)).toEqual(fenced)
    Effect.runSync(f.composed.configure("owner", restored))
    const fresh = Effect.runSync(f.apps.interact(click(fenced), output))
    const event = pending(f)[0]!
    Effect.runSync(f.composed.configure("owner", archived))
    // A legacy delayed invalidation must also leave postrestore delivery alone.
    Effect.runSync(f.apps.cancelPending("stale archive callback"))
    expect(currentApp(f)).toEqual(fresh)
    expect(pending(f)).toEqual([event])
    expect(fenced).toEqual({ ...saved, revision: saved.revision + 1 })
    expect(Effect.runSync(f.composed.read())).toMatchObject({
      revision: 2,
      status: "active",
    })
  })

  it("refuses either ledger from a different database before changing authority", () => {
    const f = fixture()
    const other = fixture()
    expect(() => appConfiguration(f.db, other.configuration, f.apps)).toThrow(
      "share its storage transaction group"
    )
    expect(() => appConfiguration(f.db, f.configuration, other.apps)).toThrow(
      "share its storage transaction group"
    )
    expect(() =>
      invalidateArchivedApps(f.db, other.configuration, () => {})
    ).toThrow("share its storage transaction group")
    expect(Effect.runSync(f.composed.read())).toMatchObject({
      revision: 0,
      status: "active",
    })
    expect(currentApp(f)).toEqual(f.app)
  })

  it("retains defects from malformed app data instead of publishing an archive", () => {
    const f = fixture()
    f.db.run("UPDATE generated_apps SET record='{}'")
    const exit = Effect.runSync(
      f.composed.configure("owner", archived).pipe(Effect.exit)
    )
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    expect(Effect.runSync(f.composed.read())).toMatchObject({
      revision: 0,
      status: "active",
    })
  })

  it("exposes the former split-transaction hole as a negative control", async () => {
    const f = fixture()
    Effect.runSync(f.apps.interact(click(f.app), output))
    let invalidations = 0
    const original: ConfigurationLedger = {
      transactionGroup: f.db,
      read: () => f.configuration.read(),
      configure: (owner, next) => f.configuration.configure(owner, next),
    }
    await Effect.runPromise(
      configureAgent(
        restoreBeforeSynchronizationRead(original),
        synchronizationHost(() =>
          Effect.sync(() => {
            invalidations++
          })
        )
      )("owner", archived)
    )
    expect(invalidations).toBe(0)
    expect(pending(f)).toHaveLength(1)
  })
})

it.each(["interaction", "preview"] as const)(
  "fences a held prearchive %s after restore without local invalidation",
  async (mode) => {
    const f = fixture()
    let enter!: () => void
    let finish!: (value: CodeOutput) => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const web = new WebApps(f.apps, () =>
      nativeOperation(
        () => {
          enter()
          return new Promise<CodeOutput>((resolve) => {
            finish = resolve
          })
        },
        (cause) => {
          if (Schema.is(AppConflict)(cause)) return cause
          throw cause
        }
      )
    )
    const input = click(f.app)
    const work =
      mode === "interaction"
        ? web.interact(input, new AbortController().signal).pipe(Effect.asVoid)
        : web
            .render(
              { id: f.app.id, version: f.app.version },
              new AbortController().signal
            )
            .pipe(Effect.asVoid)
    const running = Effect.runPromiseExit(work)
    await entered
    await Effect.runPromise(
      configureAgent(
        restoreBeforeSynchronizationRead(f.composed),
        synchronizationHost(() => Effect.die("invalidation must be skipped"))
      )("owner", archived)
    )
    finish({ result: JSON.stringify(output), logs: "", error: null })
    const exit = await running
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
    expect(currentApp(f)).toEqual({ ...f.app, revision: f.app.revision + 1 })
    expect(pending(f)).toEqual([])
    expect(Effect.runSync(f.apps.interactionReceipt(input))).toBeUndefined()
  }
)

it("preserves a fresh restored render when local archive invalidation arrives late", async () => {
  const f = fixture()
  let invalidationEntered!: () => void
  let resume!: () => void
  const invalidating = new Promise<void>((resolve) => {
    invalidationEntered = resolve
  })
  const held = new Promise<void>((resolve) => {
    resume = resolve
  })
  let entered!: () => void
  let finish!: (value: CodeOutput) => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const web = new WebApps(f.apps, () =>
    nativeOperation(
      () => {
        entered()
        return new Promise<CodeOutput>((resolve) => {
          finish = resolve
        })
      },
      (cause) => {
        throw cause
      }
    )
  )
  const archiving = Effect.runPromise(
    configureAgent(
      f.composed,
      synchronizationHost(() =>
        Effect.promise(() => {
          invalidationEntered()
          return held
        }).pipe(
          Effect.andThen(
            invalidateArchivedApps(f.db, f.composed, () => web.invalidate())
          )
        )
      )
    )("owner", archived)
  )
  await invalidating
  Effect.runSync(f.composed.configure("owner", restored))
  const input = click(currentApp(f))
  const running = Effect.runPromiseExit(
    web.interact(input, new AbortController().signal)
  )
  await started
  resume()
  await archiving
  finish({ result: JSON.stringify(output), logs: "", error: null })
  expect(Exit.isSuccess(await running)).toBe(true)
  expect(pending(f)).toHaveLength(1)
})

it("holds restore behind a coordinated archive authority read and synchronous invalidation", async () => {
  const f = fixture()
  Effect.runSync(f.composed.configure("owner", archived))
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const order: string[] = []
  const invalidating = Effect.runPromise(
    invalidateArchivedApps(
      f.db,
      {
        transactionGroup: f.db,
        read: () =>
          f.composed.read().pipe(
            Effect.tap(() =>
              Effect.promise(() => {
                entered()
                return held
              })
            )
          ),
      },
      () => {
        order.push("invalidated")
      }
    )
  )
  await started
  const restoring = Effect.runPromise(
    f.composed.configure("owner", restored)
  ).then(() => {
    order.push("restored")
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(order).toEqual([])
  release()
  await invalidating
  await restoring
  expect(order).toEqual(["invalidated", "restored"])
  expect(Effect.runSync(f.composed.read())?.status).toBe("active")
})
