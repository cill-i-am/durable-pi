import { Cause, Effect, Exit, ManagedRuntime } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import { ConnectionStore } from "../src/access/adapters/connections"
import type { ConnectionClient } from "../src/access/connection-client"
import {
  connectionApplication,
  RemoteConnections,
} from "../src/access/connection-service"
import {
  advanceConnection,
  connectionState,
  restoreConnectionState,
} from "../src/access/connection.machine"
import { ConnectionTransportError } from "../src/access/connections"
import { nativeOperation } from "../src/shared/interop"
import { database } from "./database"

const input = {
  id: `mcp-${"a".repeat(32)}`,
  name: "Synthetic",
  url: "https://mcp.example.com/mcp",
}
const gate = () => {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}
const runtimes: ManagedRuntime.ManagedRuntime<RemoteConnections, never>[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
})
function fixture() {
  let authorized = true
  const db = database(),
    store = new ConnectionStore(db)
  Effect.runSync(store.add(input))
  const client = {
    inspect: vi.fn((): ReturnType<ConnectionClient["inspect"]> =>
      Effect.succeed({
        registered: true,
        phase: "ready" as const,
        authorizeUrl: null,
      })
    ),
    tools: vi.fn(() => Effect.succeed([])),
    register: vi.fn(
      (): ReturnType<ConnectionClient["register"]> => Effect.void
    ),
    connect: vi.fn(() => Effect.succeed(true)),
    remove: vi.fn(() => Effect.void),
    discover: vi.fn(() => Effect.void),
    isCallback: vi.fn(() => Effect.succeed(true)),
    callback: vi.fn((): ReturnType<ConnectionClient["callback"]> =>
      Effect.succeed({
        authenticated: true,
        connectionId: input.id,
        revision: 1,
      })
    ),
    establish: vi.fn(() => Effect.void),
    ready: vi.fn(() => Effect.void),
    call: vi.fn(() => Effect.succeed({ content: [] })),
    settle: vi.fn(() => Effect.void),
  } satisfies ConnectionClient
  const runtime = ManagedRuntime.make(
    connectionApplication(store, client, () =>
      Effect.sync(() =>
        authorized
          ? { deadline: Date.now() + 10_000, current: () => authorized }
          : null
      )
    )
  )
  runtimes.push(runtime)
  return {
    db,
    store,
    client,
    runtime,
    service: runtime.runSync(RemoteConnections),
    revoke: () => {
      authorized = false
    },
  }
}
it("does not establish a newer generation from a callback that began before disconnect and reconnect", async () => {
  const f = fixture(),
    entered = gate(),
    release = gate()
  f.client.callback.mockImplementation(() =>
    Effect.promise(async () => {
      entered.release()
      await release.wait
      return { authenticated: true, connectionId: input.id, revision: 1 }
    })
  )
  const callback = Effect.runPromiseExit(
    f.service.callback(new Request("https://app.example.com/callback"))
  )
  await entered.wait
  Effect.runSync(f.store.change(input.id, 1, false))
  Effect.runSync(f.store.change(input.id, 2, true))
  release.release()
  expect((await callback)._tag).toBe("Failure")
  expect(f.client.establish).not.toHaveBeenCalled()
  expect(Effect.runSync(f.store.get(input.id))).toMatchObject({
    active: true,
    revision: 3,
  })
})
it("keeps a disconnected callback inactive and never establishes it", async () => {
  const f = fixture(),
    entered = gate(),
    release = gate()
  f.client.callback.mockImplementation(() =>
    Effect.promise(async () => {
      entered.release()
      await release.wait
      return { authenticated: true, connectionId: input.id, revision: 1 }
    })
  )
  const callback = Effect.runPromiseExit(
    f.service.callback(new Request("https://app.example.com/callback"))
  )
  await entered.wait
  Effect.runSync(f.store.change(input.id, 1, false))
  release.release()
  expect((await callback)._tag).toBe("Failure")
  expect(f.client.establish).not.toHaveBeenCalled()
})

it.each(["register", "connect", "discover"] as const)(
  "fences generation changes while %s is held",
  async (stage) => {
    const f = fixture(),
      entered = gate(),
      release = gate()
    f.client.inspect.mockImplementation(() =>
      Effect.succeed({
        registered: false,
        phase: "connecting",
        authorizeUrl: null,
      })
    )
    const held = Effect.promise(async () => {
      entered.release()
      await release.wait
    })
    if (stage === "connect")
      f.client.connect.mockImplementation(() => held.pipe(Effect.as(true)))
    else f.client[stage].mockImplementation(() => held)
    const pending = Effect.runPromiseExit(
      f.service.connect(input, "https://app.example.com")
    )
    await entered.wait
    Effect.runSync(f.store.change(input.id, 1, false))
    Effect.runSync(f.store.change(input.id, 2, true))
    release.release()
    expect((await pending)._tag).toBe("Failure")
    if (stage === "register") expect(f.client.connect).not.toHaveBeenCalled()
    if (stage !== "discover") expect(f.client.discover).not.toHaveBeenCalled()
    expect(Effect.runSync(f.store.get(input.id))).toMatchObject({
      active: true,
      revision: 3,
    })
  }
)
it.each(["register", "connect", "discover"] as const)(
  "rechecks current family authority after held %s",
  async (stage) => {
    const f = fixture(),
      entered = gate(),
      release = gate()
    f.client.inspect.mockImplementation(() =>
      Effect.succeed({
        registered: false,
        phase: "connecting",
        authorizeUrl: null,
      })
    )
    const held = Effect.promise(async () => {
      entered.release()
      await release.wait
    })
    if (stage === "connect")
      f.client.connect.mockImplementation(() => held.pipe(Effect.as(true)))
    else f.client[stage].mockImplementation(() => held)
    const pending = Effect.runPromiseExit(
      f.service.connect(input, "https://app.example.com")
    )
    await entered.wait
    f.revoke()
    release.release()
    expect((await pending)._tag).toBe("Failure")
    if (stage === "register") expect(f.client.connect).not.toHaveBeenCalled()
    if (stage !== "discover") expect(f.client.discover).not.toHaveBeenCalled()
  }
)
it("closes admission, rejects a queued mutation, and joins native registration before SDK settlement", async () => {
  const f = fixture(),
    entered = gate(),
    release = gate()
  f.client.inspect.mockImplementation(() =>
    Effect.succeed({
      registered: false,
      phase: "connecting",
      authorizeUrl: null,
    })
  )
  f.client.register.mockImplementation(() =>
    Effect.promise(async () => {
      entered.release()
      await release.wait
    })
  )
  const registering = Effect.runPromiseExit(
    f.service.connect(input, "https://app.example.com")
  )
  await entered.wait
  const queued = Effect.runPromiseExit(f.service.disconnect(input.id, 1))
  let closed = false
  const closing = f.runtime.dispose().then(() => {
    closed = true
  })
  await vi.waitFor(async () => {
    await expect(Effect.runPromise(f.service.list())).rejects.toThrow(
      "host has stopped"
    )
  })
  expect(closed).toBe(false)
  expect(f.client.settle).not.toHaveBeenCalled()
  release.release()
  const [registration, disconnection] = await Promise.all([registering, queued])
  await closing
  expect(registration._tag).toBe("Failure")
  expect(disconnection._tag).toBe("Failure")
  expect(f.client.connect).not.toHaveBeenCalled()
  expect(f.client.remove).not.toHaveBeenCalled()
  expect(f.client.settle).toHaveBeenCalledOnce()
  expect(Effect.runSync(f.store.get(input.id))).toMatchObject({
    active: true,
    revision: 1,
  })
})
it("joins interrupted command cleanup and preserves its complete late Cause at host shutdown", async () => {
  const f = fixture(),
    entered = gate(),
    release = gate()
  f.client.inspect.mockImplementation(() =>
    Effect.succeed({
      registered: false,
      phase: "connecting",
      authorizeUrl: null,
    })
  )
  const late = Cause.fromReasons([
    Cause.makeFailReason(
      new ConnectionTransportError({
        operation: "register",
        cause: "late checked failure",
      })
    ),
    Cause.makeDieReason("late native defect"),
  ])
  f.client.register.mockImplementation(() =>
    nativeOperation(
      async () => {
        entered.release()
        await release.wait
        throw late
      },
      (cause) => cause as ConnectionTransportError
    )
  )
  const controller = new AbortController()
  const pending = Effect.runPromiseExit(
    f.service.connect(input, "https://app.example.com"),
    { signal: controller.signal }
  )
  await entered.wait
  controller.abort()
  runtimes.splice(runtimes.indexOf(f.runtime), 1)
  const closing = Effect.runPromiseExit(f.runtime.disposeEffect)
  await vi.waitFor(async () => {
    await expect(Effect.runPromise(f.service.list())).rejects.toThrow(
      "host has stopped"
    )
  })
  release.release()
  const result = await pending,
    shutdown = await closing
  expect(Exit.isFailure(result) && Cause.hasDies(result.cause)).toBe(true)
  expect(String(result)).toContain("late native defect")
  expect(String(result)).toContain("late checked failure")
  expect(Exit.isFailure(shutdown) && Cause.hasDies(shutdown.cause)).toBe(true)
  expect(String(shutdown)).toContain("late native defect")
  expect(f.client.connect).not.toHaveBeenCalled()
})
it("restores compatible active rows and finishes a pre-connect admission using the original identity", async () => {
  const f = fixture()
  f.client.inspect.mockImplementation(() =>
    Effect.succeed({
      registered: false,
      phase: "unavailable",
      authorizeUrl: null,
    })
  )
  const before = Effect.runSync(f.store.get(input.id))!
  expect(
    restoreConnectionState(JSON.parse(JSON.stringify(connectionState(before))))
  ).toEqual(connectionState(before))
  await Effect.runPromise(f.service.connect(input, "https://app.example.com"))
  expect(f.client.register).toHaveBeenCalledWith(
    before,
    "https://app.example.com"
  )
  expect(f.client.connect).toHaveBeenCalledWith(before)
  expect(Effect.runSync(f.store.get(input.id))).toEqual(before)
  expect(() =>
    restoreConnectionState({ ...connectionState(before), workflowVersion: 2 })
  ).toThrow()
  expect(() =>
    restoreConnectionState({
      ...connectionState(before),
      record: { ...before, active: "yes" },
    })
  ).toThrow()
  expect(() =>
    advanceConnection(before, { type: "DISCONNECT", expectedRevision: -1 })
  ).toThrow()
})
it("replays a disconnected revision without rewriting it and never removes before its commit", async () => {
  const f = fixture()
  await Effect.runPromise(f.service.disconnect(input.id, 1))
  f.db.run(
    "CREATE TRIGGER reject_replay BEFORE UPDATE ON access_connections BEGIN SELECT RAISE(ABORT,'unexpected rewrite'); END"
  )
  await Effect.runPromise(f.service.disconnect(input.id, 1))
  expect(f.client.remove).toHaveBeenCalledTimes(2)
  expect(Effect.runSync(f.store.get(input.id))).toMatchObject({
    active: false,
    revision: 2,
  })
})

it.each(["add", "change"] as const)(
  "checks admission authority after acquiring the real SQLite coordinator for %s",
  async (mutation) => {
    const f = fixture(),
      held = gate(),
      release = gate(),
      entered = gate()
    const holder = Effect.runPromise(
      f.db.transaction(() =>
        Effect.gen(function* () {
          held.release()
          yield* Effect.promise(() => release.wait)
        })
      )
    )
    await held.wait
    if (mutation === "add") {
      const add = f.store.add.bind(f.store)
      f.store.add = (input, eligible) =>
        Effect.sync(entered.release).pipe(Effect.andThen(add(input, eligible)))
    } else {
      const change = f.store.change.bind(f.store)
      f.store.change = (id, revision, active, eligible) =>
        Effect.sync(entered.release).pipe(
          Effect.andThen(change(id, revision, active, eligible))
        )
    }
    const work = Effect.runPromiseExit(
      mutation === "add"
        ? f.service.connect(
            { ...input, id: `mcp-${"b".repeat(32)}` },
            "https://app.example.com"
          )
        : f.service.disconnect(input.id, 1)
    )
    await entered.wait
    f.revoke()
    release.release()
    await holder
    expect((await work)._tag).toBe("Failure")
    expect(Effect.runSync(f.store.get(input.id))).toMatchObject({
      active: true,
      revision: 1,
    })
    expect(Effect.runSync(f.store.list())).toHaveLength(1)
    expect(f.client.remove).not.toHaveBeenCalled()
    expect(f.client.register).not.toHaveBeenCalled()
  }
)
