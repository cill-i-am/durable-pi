import { Effect, Cause, Exit } from "effect"
import { describe, expect, it, vi } from "vitest"

import { routinesRequest } from "../src/routines/adapters/http"
import { routineTools } from "../src/routines/adapters/pi"
import { RoutineStorageError } from "../src/routines/persistence"
import { routinePump } from "../src/routines/pump"
import { database } from "./database"
import { routineFixture } from "./routine-fixture"

const input = () => ({
  id: crypto.randomUUID(),
  operationId: crypto.randomUUID(),
  title: "Check notes",
  prompt: "Read saved notes.",
  expectedRevision: 0,
  schedule: { type: "once" as const, at: Date.now() + 3600_000 },
  status: "active" as const,
})
const unavailable = () =>
  new RoutineStorageError({
    operation: "schedule",
    cause: new Error("scheduler unavailable"),
  })
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture() {
  const db = database(),
    store = routineFixture(db, () => true)
  const request = (
    path: string,
    body: unknown,
    wake: () => Effect.Effect<number, RoutineStorageError>
  ) =>
    Effect.runPromise(
      routinesRequest(
        store.service,
        new Request(`https://test/api/agent/${path}`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
        path,
        wake,
        () => Effect.void
      )
    )
  return { db, store, request }
}
describe("routine command recovery authority", () => {
  it("pause, archive, cancellation and exact receipt replay survive scheduler outage", async () => {
    const f = fixture(),
      saved = input(),
      wake = vi.fn(() => Effect.fail(unavailable()))
    f.store.save(saved)
    const pending = f.store.runNow({
      id: saved.id,
      operationId: crypto.randomUUID(),
      expectedRevision: 1,
    }).run!
    expect(
      (
        await f.request(
          "routines/status",
          {
            id: saved.id,
            operationId: crypto.randomUUID(),
            expectedRevision: 1,
            status: "paused",
          },
          wake
        )
      ).status
    ).toBe(200)
    expect(f.store.runs()[0]).toMatchObject({
      id: pending.id,
      status: "cancelled",
    })
    expect(
      (
        await f.request(
          "routines/status",
          {
            id: saved.id,
            operationId: crypto.randomUUID(),
            expectedRevision: 2,
            status: "archived",
          },
          wake
        )
      ).status
    ).toBe(200)
    expect(
      (
        await f.request(
          "routines/cancel",
          { operationId: crypto.randomUUID() },
          wake
        )
      ).status
    ).toBe(200)
    expect((await f.request("routines/save", saved, wake)).status).toBe(200)
    expect(
      (await f.request("routines/save", { ...saved, prompt: "Changed" }, wake))
        .status
    ).toBe(409)
    expect(wake).not.toHaveBeenCalled()
    expect(f.store.get(saved.id)?.status).toBe("archived")
  })
  it("a fresh activation still requires discovery; a lost acknowledgement replays without it", async () => {
    const f = fixture(),
      saved = input(),
      failed = vi.fn(() => Effect.fail(unavailable()))
    expect((await f.request("routines/save", saved, failed)).status).toBe(409)
    expect(f.store.list()).toHaveLength(0)
    let calls = 0
    const wake = () =>
      ++calls === 1
        ? Effect.succeed(Date.now() + 60_000)
        : Effect.fail(unavailable())
    expect((await f.request("routines/save", saved, wake)).status).toBe(409)
    expect(f.store.get(saved.id)?.revision).toBe(1)
    failed.mockClear()
    expect((await f.request("routines/save", saved, failed)).status).toBe(200)
    expect(failed).not.toHaveBeenCalled()
    expect(f.store.get(saved.id)?.revision).toBe(1)
  })
  it("native Pi tools share the outage-safe pause and exact replay machine", async () => {
    const f = fixture(),
      saved = input()
    f.store.save(saved)
    const wake = vi.fn(async (): Promise<number> => {
      throw new Error("scheduler unavailable")
    })
    const tools = routineTools(f.store.service, wake, (effect, signal) =>
      Effect.runPromise(effect, { signal })
    )
    const pause = tools.find((tool) => tool.name === "set_routine_status")!
    const invoke = () =>
      Reflect.apply(pause.execute, undefined, [
        { id: saved.id, expectedRevision: 1, status: "paused" },
        { taskId: "native-pause-identity" },
        {},
      ]) as Promise<unknown>
    const first = await invoke()
    expect(await invoke()).toEqual(first)
    expect(f.store.get(saved.id)?.status).toBe("paused")
    expect(f.store.get(saved.id)?.revision).toBe(2)
    expect(wake).not.toHaveBeenCalled()
  })
  it("joins native cleanup before a second pump can enter the occupied local scope", async () => {
    const f = fixture(),
      saved = input(),
      entered = deferred(),
      cleanup = deferred(),
      release = deferred()
    f.store.save(saved)
    f.store.runNow({
      id: saved.id,
      expectedRevision: 1,
      operationId: crypto.randomUUID(),
    })
    let calls = 0
    const modelConnected = () =>
      ++calls === 1
        ? Effect.acquireUseRelease(
            Effect.sync(entered.resolve),
            () => Effect.never,
            () =>
              Effect.uninterruptible(
                Effect.promise(async () => {
                  cleanup.resolve()
                  await release.promise
                })
              )
          )
        : Effect.succeed(false)
    const pump = routinePump(f.store.service, {
      canAdmit: () => Effect.succeed(true),
      modelConnected,
      prearm: () => Effect.succeed(Date.now() + 60_000),
      getTurn: () => Effect.succeed(undefined),
      admission: {
        transactionGroup: f.db,
        admit: () => Effect.die("unexpected admission"),
      },
      stop: () => Effect.void,
      wakeConversation: () => Effect.void,
      notify: () => Effect.void,
    })
    const controller = new AbortController()
    let closed = false
    const first = Effect.runPromiseExit(pump.run(), {
      signal: controller.signal,
    }).then((exit) => {
      closed = true
      return exit
    })
    await entered.promise
    controller.abort()
    await cleanup.promise
    const second = Effect.runPromise(pump.run())
    await Promise.resolve()
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(calls).toBe(1)
    release.resolve()
    const exit = await first
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    await second
    expect(calls).toBe(2)
    expect(f.store.inFlight()?.status).toBe("pending")
  })
})
