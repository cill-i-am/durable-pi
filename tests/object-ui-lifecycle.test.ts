import { it as effectIt } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { afterEach, expect, it, vi } from "vitest"

import { objectCreationMachine } from "../src/features/objects/object-creation.machine"
import { objectEditMachine } from "../src/features/objects/object-edit.machine"
import { objectOriginMachine } from "../src/features/objects/object-origin.machine"
import { objectPollMachine } from "../src/features/objects/object-poll.machine"
import { readObjectDrafts } from "../src/features/objects/object-storage"
import { ObjectStore } from "../src/features/objects/store"
import { ApiError } from "../src/http/client"
import {
  type ObjectDetail,
  type ObjectMutation,
  objectSummary,
} from "../src/objects/contracts"
import { nativeOperation } from "../src/shared/interop"

const id = "11111111-1111-4111-8111-111111111111"
const input: ObjectMutation = {
  id,
  operationId: "22222222-2222-4222-8222-222222222222",
  expectedRevision: 1,
  action: { type: "update", changes: [{ type: "edit", title: "My draft" }] },
}
const source = {
  actor: "user" as const,
  surface: "workbench" as const,
  turnId: null,
  toolCallId: null,
}
const detail = (revision = 1): ObjectDetail => ({
  object: {
    id,
    type: "project_checklist",
    schemaVersion: 1,
    revision,
    title: `r${revision}`,
    notes: "",
    tasks: [],
    archived: false,
    origin: source,
    createdAt: "2026-10-23",
    updatedAt: "2026-10-23",
    lastEvent: revision,
  },
  events: [
    {
      id: `${id}:${revision}`,
      objectId: id,
      revision,
      sequence: revision,
      source,
      at: "2026-10-23",
      changes: [],
    },
  ],
  nextHistory: null,
})
const receipt = (revision = 2) => ({
  objectId: id,
  revision,
  eventId: `${id}:${revision}`,
})
const stores: ObjectStore[] = []
const store = (api: ConstructorParameters<typeof ObjectStore>[0]) => {
  const value = new ObjectStore(api, "drafts")
  stores.push(value)
  return value
}
afterEach(async () => {
  await Promise.all(
    stores.splice(0).map((value) => value.dispose().catch(() => {}))
  )
})
const disk = (initial = "[]") => {
  let value = initial
  return {
    read: () => value,
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next
    },
  }
}
const barrier = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it("newer read survives an older list completion and unrelated requests never replay saves", async () => {
  const entered = barrier<void>(),
    old = barrier<unknown>()
  let calls = 0
  const owner = store(async <T>() => {
    if (++calls === 1) {
      entered.resolve()
      return (await old.promise) as T
    }
    return { objects: [objectSummary(detail(2).object)] } as T
  })
  const loading = owner.refresh()
  await entered.promise
  await owner.refresh()
  old.resolve({ objects: [] })
  await loading
  // The superseded caller settles at replacement; let the held native promise join.
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(owner.getSnapshot().list[0]?.revision).toBe(2)
})
it.each(['{"schemaVersion":99,"draft":"keep"}', "not-json"])(
  "unknown browser data remains byte-identical and blocks new saves: %s",
  async (raw) => {
    const saved = disk(raw),
      api = vi.fn(async () => {
        throw Error("must not request")
      }),
      owner = store(api)
    owner.connect(saved)
    expect(await owner.submit(input)).toBe(false)
    expect(saved.read()).toBe(raw)
    expect(api).not.toHaveBeenCalled()
    expect(owner.getSnapshot().error).toContain("compatible version")
  }
)
it("legacy pending mutations preserve complete content and never submit on connect", async () => {
  const saved = disk(JSON.stringify([input])),
    calls: ObjectMutation[] = []
  const owner = store(async <T>(path: string, body?: unknown) => {
    if (path === "objects/mutate") {
      calls.push(body as ObjectMutation)
      return receipt() as T
    }
    return (path === "objects" ? { objects: [] } : detail(2)) as T
  })
  owner.connect(saved)
  expect(calls).toEqual([])
  expect(owner.getSnapshot().pending[id]).toEqual(input)
  expect(await owner.retry(id)).toBe(true)
  expect(calls).toEqual([input])
  expect(saved.read()).toBe("[]")
})
it("reload preserves a conflict and explicit reapply lineage; no conflict is automatically retried", async () => {
  const saved = disk(),
    calls: ObjectMutation[] = []
  let revision = 2
  const api = async <T>(path: string, body?: unknown) => {
    if (path === "objects/mutate") {
      const mutation = body as ObjectMutation
      calls.push(mutation)
      if (mutation.expectedRevision !== revision)
        throw new ApiError(409, "Newer revision")
      return receipt(++revision) as T
    }
    return (path === "objects" ? { objects: [] } : detail(revision)) as T
  }
  const first = store(api)
  first.connect(saved)
  expect(await first.submit(input)).toBe(false)
  expect(first.getSnapshot().problems[id]?.kind).toBe("conflict")
  await first.dispose()
  const second = store(api)
  second.connect(saved)
  await second.load(id)
  expect(second.getSnapshot().problems[id]?.input).toEqual(input)
  expect(calls).toHaveLength(1)
  revision = 3
  expect(await second.reapply(id)).toBe(false)
  const attempted = calls[1]!
  expect(attempted.operationId).not.toBe(input.operationId)
  expect(attempted.expectedRevision).toBe(2)
  expect(attempted.action).toEqual(input.action)
  await second.dispose()
  const third = store(api)
  third.connect(saved)
  await third.load(id)
  expect(await third.reapply(id)).toBe(true)
  expect(calls[2]!.expectedRevision).toBe(3)
  expect(calls[2]!.operationId).not.toBe(attempted.operationId)
  expect(third.getSnapshot().settled[input.operationId]).toBe(true)
  expect(third.getSnapshot().settled[attempted.operationId]).toBe(true)
})
it("storage failure after receipt keeps the exact attempt actionable without new content", async () => {
  const saved = disk(),
    calls: ObjectMutation[] = []
  let fail = false
  const owner = store(async <T>(path: string, body?: unknown) => {
    if (path === "objects/mutate") {
      calls.push(body as ObjectMutation)
      fail = true
      return receipt() as T
    }
    return (path === "objects" ? { objects: [] } : detail(2)) as T
  })
  owner.connect({
    ...saved,
    setItem: (key, value) => {
      if (fail) throw Error("storage full")
      saved.setItem(key, value)
    },
  })
  expect(await owner.submit(input)).toBe(false)
  expect(readObjectDrafts(saved.read())[0]?.input).toEqual(input)
  expect(owner.getSnapshot().pending[id]).toEqual(input)
  fail = false
  // A fresh facade models reload after storage recovers; the same receipt is rejoined.
  const recovered = store(async <T>(path: string, body?: unknown) => {
    if (path === "objects/mutate") {
      calls.push(body as ObjectMutation)
      return receipt() as T
    }
    return (path === "objects" ? { objects: [] } : detail(2)) as T
  })
  recovered.connect(saved)
  expect(await recovered.retry(id)).toBe(true)
  expect(calls).toEqual([input, input])
})
it("invalid cancellation acknowledgement cannot discard the retained operation", async () => {
  const saved = disk(JSON.stringify([input])),
    owner = store(async <T>(path: string) =>
      path === "objects/cancel" ? ({ applied: "yes" } as T) : (detail() as T)
    )
  owner.connect(saved)
  await owner.cancel(id)
  expect(owner.getSnapshot().pending[id]).toEqual(input)
  expect(readObjectDrafts(saved.read())[0]?.input).toEqual(input)
})
it("concurrent saves admit one immutable attempt and local disposal aborts then joins its native request", async () => {
  const saved = disk(),
    entered = barrier<void>(),
    release = barrier<unknown>()
  let signal: AbortSignal | undefined,
    writes = 0
  const owner = store(
    async <T>(path: string, _body?: unknown, nativeSignal?: AbortSignal) => {
      if (path !== "objects/mutate") return detail() as T
      writes++
      signal = nativeSignal
      entered.resolve()
      return (await release.promise) as T
    }
  )
  owner.connect(saved)
  const saving = owner.submit(input)
  await entered.promise
  expect(
    await owner.submit({ ...input, operationId: crypto.randomUUID() })
  ).toBe(false)
  expect(writes).toBe(1)
  let closed = false
  const closing = owner.dispose().then(() => {
    closed = true
  })
  await vi.waitFor(() => expect(signal?.aborted).toBe(true))
  expect(closed).toBe(false)
  const retained = saved.read()
  release.resolve(receipt())
  await closing
  expect(await saving).toBe(false)
  expect(saved.read()).toBe(retained)
  expect(readObjectDrafts(saved.read())[0]?.input.operationId).toBe(
    input.operationId
  )
  await owner.refresh()
  expect(writes).toBe(1)
})
it("late native cleanup preserves checked failure and defect in the owner's close Cause", async () => {
  const entered = barrier<void>(),
    aborted = barrier<void>()
  let reject!: (cause: unknown) => void
  const owner = store(
    async <T>(path: string, _body?: unknown, signal?: AbortSignal) => {
      if (path !== "objects/mutate") return detail() as T
      signal?.addEventListener("abort", () => aborted.resolve())
      entered.resolve()
      return (await new Promise((_resolve, fail) => {
        reject = fail
      })) as T
    }
  )
  owner.connect(disk())
  const saving = owner.submit(input)
  await entered.promise
  const closing = owner.dispose().catch((cause) => cause)
  await aborted.promise
  const failure = Cause.fromReasons([
    ...Cause.fail(new Error("cleanup checked")).reasons,
    ...Cause.die(new Error("cleanup defect")).reasons,
    ...Cause.interrupt(81234).reasons,
  ])
  reject(failure)
  const cause = await closing
  expect(Cause.isCause(cause)).toBe(true)
  const reasons = (cause as Cause.Cause<unknown>).reasons
    .map((reason) =>
      reason._tag === "Die" ? String(reason.defect) : String(reason)
    )
    .join("\n")
  expect(reasons).toContain("cleanup checked")
  expect(reasons).toContain("cleanup defect")
  expect(
    (cause as Cause.Cause<unknown>).reasons.some(
      (reason) => reason._tag === "Interrupt" && reason.fiberId === 81234
    )
  ).toBe(true)
  await saving
})
it("mismatched detail identities do not populate another object's cache", async () => {
  const owner = store(
    async <T>() =>
      ({
        ...detail(),
        object: { ...detail().object, id: crypto.randomUUID() },
      }) as T
  )
  await owner.load(id)
  expect(owner.getSnapshot().details).toEqual({})
  expect(owner.getSnapshot().error).toContain("another checklist")
})
effectIt.effect(
  "visibility owns poll progression while retained save identity remains outside the polling machine",
  () =>
    Effect.gen(function* () {
      let reads = 0
      const actor = yield* createEffectActor(
        objectPollMachine(() =>
          Effect.sync(() => {
            reads++
          })
        )
      )
      yield* send(actor, { type: "OBSERVE", active: true, visible: true })
      yield* waitFor(actor, (state) => state.matches("waiting"))
      expect(reads).toBe(1)
      yield* send(actor, { type: "OBSERVE", active: true, visible: false })
      yield* waitFor(actor, (state) => state.matches("paused"))
      yield* TestClock.adjust("20 seconds")
      expect(reads).toBe(1)
      yield* send(actor, { type: "OBSERVE", active: true, visible: true })
      yield* waitFor(actor, (state) => state.matches("waiting"))
      expect(reads).toBe(2)
    }).pipe(Effect.scoped)
)
effectIt.effect(
  "creation completion after selected-view ABA cannot select the old creation",
  () =>
    Effect.gen(function* () {
      const actor = yield* createEffectActor(objectCreationMachine, {
          input: null,
        }),
        selected: string[] = []
      actor.on("selected", (event) => selected.push(event.id))
      yield* send(actor, { type: "BEGIN", id })
      yield* waitFor(actor, (state) => state.matches("editing"))
      yield* send(actor, { type: "VIEW", selected: "other" })
      yield* send(actor, { type: "VIEW", selected: null })
      yield* waitFor(actor, (state) => state.context.revision === 2)
      yield* send(actor, { type: "STATUS", id, pending: false, saved: true })
      yield* waitFor(actor, (state) => state.matches("idle"))
      expect(selected).toEqual([])
    }).pipe(Effect.scoped)
)
effectIt.effect(
  "closing origin during a held native read never reopens it; scope joins actual cleanup",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = barrier<unknown>(),
        scope = yield* Scope.make()
      let aborted = false
      const actor = yield* createEffectActor(
        objectOriginMachine(() =>
          nativeOperation(
            (signal) => {
              signal.addEventListener("abort", () => {
                aborted = true
              })
              Effect.runSync(Deferred.succeed(entered, undefined))
              return release.promise
            },
            (cause) => cause
          ).pipe(
            Effect.as({
              id,
              text: "origin",
              answer: "answer",
              createdAt: "2026-10-23",
            })
          )
        ),
        { input: id }
      ).pipe(Effect.provideService(Scope.Scope, scope))
      yield* send(actor, { type: "OPEN" })
      yield* Deferred.await(entered)
      yield* send(actor, { type: "CLOSE" })
      yield* waitFor(actor, (state) => state.matches("closed"))
      let joined = false
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            joined = true
          })
        ),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      expect(aborted).toBe(true)
      expect(joined).toBe(false)
      release.resolve({})
      yield* Fiber.join(closing)
      expect(actor.getSnapshot().context.origin).toBeNull()
    }).pipe(Effect.scoped)
)

effectIt.effect(
  "malformed mutation events never reach persistence or native dispatch",
  () =>
    Effect.gen(function* () {
      let writes = 0
      const actor = yield* createEffectActor(
        objectEditMachine({
          retain: () =>
            Effect.sync(() => {
              writes++
            }),
          save: () =>
            Effect.sync(() => {
              writes++
              return receipt()
            }),
          cancel: () => Effect.succeed({ applied: false }),
          problem: (_cause, input) => ({
            kind: "uncertain",
            message: "failed",
            input,
          }),
        }),
        { input: null }
      )
      yield* send(actor, {
        type: "SUBMIT",
        request: "malformed",
        input: { ...input, expectedRevision: -1 },
      } as never)
      yield* Effect.yieldNow
      expect(writes).toBe(0)
      expect(actor.getSnapshot().context.draft).toBeNull()
    }).pipe(Effect.scoped)
)

it("an interrupted version1 pre-dispatch record restores actionable uncertainty", () => {
  const saved = disk(
    JSON.stringify({
      schemaVersion: 1,
      workflowVersion: 1,
      drafts: [{ input, pending: true, problem: null, replaces: [] }],
    })
  )
  const owner = store(async <T>() => detail() as T)
  owner.connect(saved)
  expect(owner.getSnapshot().problems[id]?.kind).toBe("uncertain")
  expect(owner.getSnapshot().pending[id]).toEqual(input)
})

it.each([
  { pending: false, kind: "uncertain" as const },
  { pending: false, kind: null },
  { pending: true, kind: "conflict" as const },
  { pending: true, kind: "error" as const },
])(
  "inconsistent persisted outcome %j remains byte-identical and cannot be dismissed",
  async ({ pending, kind }) => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      workflowVersion: 1,
      drafts: [
        {
          input,
          pending,
          problem: kind ? { kind, message: "recover", input } : null,
          replaces: [],
        },
      ],
    })
    const saved = disk(raw),
      api = vi.fn(async () => {
        throw Error("must not dispatch")
      }),
      owner = store(api)
    owner.connect(saved)
    expect(owner.getSnapshot().error).toContain("could not be read")
    expect(await owner.dismiss(id)).toBe(false)
    expect(saved.read()).toBe(raw)
    expect(api).not.toHaveBeenCalled()
  }
)
