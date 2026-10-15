import { afterEach, expect, it } from "vitest"
import { it as effectIt } from "@effect/vitest"
import { Cause, Context, Effect, Exit } from "effect"
import { TestClock } from "effect/testing"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import { Harness, createRegistry } from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { createModels } from "@earendil-works/pi-ai"
import { piObjectLedger, objectDigest } from "../src/objects/adapters/pi"
import { makeWorkingObjects } from "../src/objects/service"
import { objectsRequest } from "../src/objects/adapters/http"
import type { ObjectLedger } from "../src/objects/ledger"
import type { ChangeSource, ObjectMutation } from "../src/objects/contracts"
import {
  objectOfferedThrough,
  requireObjectCapacity,
} from "../src/objects/domain"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})
const user: ChangeSource = {
  actor: "user",
  surface: "workbench",
  turnId: null,
  toolCallId: null,
}
const input = (): ObjectMutation => ({
  id: crypto.randomUUID(),
  operationId: crypto.randomUUID(),
  expectedRevision: 0,
  action: { type: "create", title: "Native object", notes: "", tasks: [] },
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "object-boundary-"))
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(directory, "pi.sqlite")),
    {
      models: createModels(),
      registry: createRegistry(),
    },
    ctx
  )
  cleanups.push(async () => {
    await harness.close(ctx)
    await rm(directory, { recursive: true, force: true })
  })
  const ledger = piObjectLedger(async () => harness)
  return {
    harness,
    ledger,
    objects: makeWorkingObjects(ledger, () => true, objectDigest),
  }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
it("retains failed checklist request cleanup instead of returning an invalid-input response", async () => {
  const f = await fixture()
  const cleanup = new Error("private checklist reader cleanup")
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(800_001))
    },
    cancel() {
      return Promise.reject(cleanup)
    },
  })
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    body,
    duplex: "half",
  }
  const exit = await Effect.runPromiseExit(
    objectsRequest(
      f.objects,
      new Request("https://internal/api/agent/objects/mutate", init),
      "objects/mutate",
      () => undefined
    )
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit))
    expect(exit.cause.reasons).toContainEqual(
      expect.objectContaining({ _tag: "Die", defect: cleanup })
    )
  expect(body.locked).toBe(false)
  expect(await Effect.runPromise(f.objects.list())).toEqual([])
})

effectIt.effect(
  "native commit callbacks retain invocation Context and Clock",
  () =>
    Effect.gen(function* () {
      const f = yield* Effect.promise(fixture)
      class Invocation extends Context.Service<
        Invocation,
        { marker: string }
      >()("ObjectInvocation") {}
      const marker = yield* f.ledger
        .atomic(() => Invocation.pipe(Effect.map((value) => value.marker)))
        .pipe(Effect.provideService(Invocation, { marker: "this invocation" }))
      expect(marker).toBe("this invocation")
      yield* TestClock.setTime(15_000)
      const mutation = input()
      yield* f.objects.mutate(mutation, user)
      expect((yield* f.objects.read(mutation.id)).object.createdAt).toBe(
        "1970-01-01T00:00:15.000Z"
      )
    })
)

it("returns detached replay receipts after the native overlay settles", async () => {
  const f = await fixture(),
    mutation = input()
  const first = await Effect.runPromise(f.objects.mutate(mutation, user))
  const replay = await Effect.runPromise(f.objects.mutate(mutation, user))
  expect(replay).toEqual(first)
  expect(JSON.parse(JSON.stringify(replay))).toEqual(first)
  expect(
    (await Effect.runPromise(f.objects.read(mutation.id))).events
  ).toHaveLength(1)
})

it("rolls back callback defects and retains their Cause through the native bridge", async () => {
  const f = await fixture()
  const failure = await Effect.runPromiseExit(
    f.ledger.atomic((tx) =>
      Effect.gen(function* () {
        const catalog = yield* tx.catalog()
        catalog.sequence = 9
        return yield* Effect.die(new Error("Object callback invariant"))
      })
    )
  )
  expect(Exit.isFailure(failure) && Cause.hasDies(failure.cause)).toBe(true)
  expect(Exit.isFailure(failure) && Cause.hasFails(failure.cause)).toBe(false)
  expect((await Effect.runPromise(f.objects.context())).sequence).toBe(0)
  const construction = await Effect.runPromiseExit(
    f.ledger.atomic(() => {
      throw new Error("Object callback construction bug")
    })
  )
  expect(
    Exit.isFailure(construction) && Cause.hasDies(construction.cause)
  ).toBe(true)
})

it("treats corrupt checklist and replay records as defects at both service and HTTP boundaries", async () => {
  const f = await fixture(),
    mutation = input()
  await Effect.runPromise(f.objects.mutate(mutation, user))
  await Effect.runPromise(
    f.ledger.atomic((tx) =>
      tx.checklist(mutation.id).pipe(
        Effect.map((stored) => {
          if (!stored.value) throw new Error("Missing fixture object")
          stored.value = { ...stored.value, revision: -1 }
        })
      )
    )
  )
  const read = await Effect.runPromiseExit(
    objectsRequest(
      f.objects,
      new Request(`https://app.example.com/objects/${mutation.id}`),
      `objects/${mutation.id}`,
      () => undefined
    )
  )
  expect(Exit.isFailure(read) && Cause.hasDies(read.cause)).toBe(true)
  await Effect.runPromise(
    f.ledger.atomic((tx) =>
      tx.operation(mutation.operationId).pipe(
        Effect.map((operation) => {
          if (!operation.receipt) throw new Error("Missing fixture receipt")
          operation.receipt = { ...operation.receipt, revision: -1 }
        })
      )
    )
  )
  const replay = await Effect.runPromiseExit(f.objects.mutate(mutation, user))
  expect(Exit.isFailure(replay) && Cause.hasDies(replay.cause)).toBe(true)
})

it("replays a committed change after a lost native acknowledgment and still requires current authority", async () => {
  const f = await fixture(),
    mutation = input()
  const commit = f.harness.commit.bind(f.harness)
  let loseAck = true,
    writable = true
  f.harness.commit = async (change, context) => {
    const result = await commit(change, context)
    if (loseAck) {
      loseAck = false
      throw new Error("Native acknowledgment lost")
    }
    return result
  }
  const objects = makeWorkingObjects(f.ledger, () => writable, objectDigest)
  expect(
    await Effect.runPromise(objects.mutate(mutation, user).pipe(Effect.result))
  ).toMatchObject({ _tag: "Failure", failure: { code: "unavailable" } })
  const replay = await Effect.runPromise(objects.mutate(mutation, user))
  expect(replay.revision).toBe(1)
  expect(
    (await Effect.runPromise(objects.read(mutation.id))).events
  ).toHaveLength(1)
  writable = false
  expect(
    await Effect.runPromise(objects.mutate(mutation, user).pipe(Effect.result))
  ).toMatchObject({ _tag: "Failure", failure: { code: "read_only" } })
})

it("checks authority after the last native document read and rolls back refused publication", async () => {
  const f = await fixture(),
    entered = deferred(),
    release = deferred(),
    mutation = input()
  let writable = true
  const ledger: ObjectLedger = {
    ...f.ledger,
    atomic: (change) =>
      f.ledger.atomic((tx) =>
        change({
          ...tx,
          event: (id) =>
            tx.event(id).pipe(
              Effect.tap(() =>
                Effect.promise(async () => {
                  entered.resolve()
                  await release.promise
                })
              )
            ),
        })
      ),
  }
  const objects = makeWorkingObjects(ledger, () => writable, objectDigest)
  const pending = Effect.runPromise(
    objects.mutate(mutation, user).pipe(Effect.result)
  )
  await entered.promise
  writable = false
  release.resolve()
  expect(await pending).toMatchObject({
    _tag: "Failure",
    failure: { code: "read_only" },
  })
  expect(await Effect.runPromise(f.objects.context())).toEqual({
    sequence: 0,
    offeredThrough: 0,
    objects: [],
  })
})

it("joins interrupted native commit acknowledgment before releasing caller resources", async () => {
  const f = await fixture(),
    entered = deferred(),
    release = deferred(),
    aborted = deferred(),
    mutation = input()
  const commit = f.harness.commit.bind(f.harness)
  f.harness.commit = async (change, context) => {
    const result = await commit(change, context)
    context.abortSignal?.addEventListener("abort", aborted.resolve, {
      once: true,
    })
    entered.resolve()
    await release.promise
    return result
  }
  let alive = false
  const controller = new AbortController()
  const pending = Effect.runPromiseExit(
    Effect.acquireUseRelease(
      Effect.sync(() => {
        alive = true
      }),
      () => f.objects.mutate(mutation, user),
      () =>
        Effect.sync(() => {
          alive = false
        })
    ),
    { signal: controller.signal }
  )
  await entered.promise
  controller.abort()
  await aborted.promise
  expect(alive).toBe(true)
  release.resolve()
  const result = await pending
  expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true)
  expect(alive).toBe(false)
  f.harness.commit = commit
  expect(
    (await Effect.runPromise(f.objects.mutate(mutation, user))).revision
  ).toBe(1)
  expect(
    (await Effect.runPromise(f.objects.read(mutation.id))).events
  ).toHaveLength(1)
})

it("keeps object capacity and offered event progress bounded and monotonic", () => {
  for (const operations of [19_999, 20_000, 20_001])
    for (const count of [49, 50, 51])
      for (const creating of [false, true]) {
        const check = () => requireObjectCapacity(operations, count, creating)
        if (operations >= 20_000 || (creating && count >= 50))
          expect(check).toThrow()
        else expect(check).not.toThrow()
      }
  for (let previous = 0; previous <= 5; previous++)
    for (let current = previous; current <= 8; current++)
      for (let offered = 0; offered <= 10; offered++) {
        const next = objectOfferedThrough(previous, offered, current)
        expect(next).toBeGreaterThanOrEqual(previous)
        expect(next).toBeLessThanOrEqual(current)
        expect(objectOfferedThrough(next, offered, current)).toBe(next)
      }
})
