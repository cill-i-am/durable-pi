import { it } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"

import { makeFilesCache } from "../src/features/files/file-cache"
import { fileMutationMachine } from "../src/features/files/file-mutation.machine"
import { fileRefreshMachine } from "../src/features/files/file-refresh.machine"
import { makeFilesOwner } from "../src/features/files/files-owner"
import { uploadsMachine } from "../src/features/files/uploads.machine"
import { nativeOperation } from "../src/shared/interop"
import type { FileInfo } from "../src/workspace/files"

const file: FileInfo = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "proof.txt",
  mime: "text/plain",
  kind: "text",
  size: 1,
  createdAt: "2026-10-23T00:00:00Z",
  status: "ready",
  trashed: false,
}
const request = () => ({
  id: file.id,
  file: new File(["a"], file.name),
  attach: true,
})

it.effect(
  "duplicate admissions cannot start another upload, and explicit retry keeps the exact reservation and content",
  () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<FileInfo, string>()
      const started = yield* Deferred.make<void>()
      const calls: unknown[] = [],
        published: FileInfo[] = []
      const input = request()
      const actor = yield* createEffectActor(
        uploadsMachine(
          (attempt) =>
            Effect.sync(() => calls.push(attempt)).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(gate))
            ),
          (_, value) =>
            Effect.sync(() => {
              published.push(value)
            })
        )
      )
      const first = yield* Deferred.make<void>(),
        duplicate = yield* Deferred.make<void>()
      yield* send(actor, {
        type: "START",
        requests: [input],
        capacity: 4,
        retry: false,
        reply: first,
      })
      yield* Deferred.await(started)
      yield* send(actor, {
        type: "START",
        requests: [input],
        capacity: 4,
        retry: false,
        reply: duplicate,
      })
      yield* Deferred.await(duplicate)
      expect(calls).toHaveLength(1)
      yield* Deferred.fail(gate, "connection lost")
      yield* Deferred.await(first)
      const failed = actor.getSnapshot().context.attempts[0]!
      expect(failed).toMatchObject({ id: input.id, status: "failed" })
      const retry = yield* Deferred.make<void>()
      yield* send(actor, {
        type: "START",
        requests: [failed],
        capacity: 4,
        retry: true,
        reply: retry,
      })
      yield* Deferred.await(retry)
      expect(calls).toHaveLength(2)
      expect(calls[0]).toMatchObject({ id: input.id, file: input.file })
      expect(calls[1]).toMatchObject({ id: input.id, file: input.file })
      expect((calls[1] as typeof input).file).toBe(input.file)
      expect(published).toEqual([])
    }).pipe(Effect.scoped)
)

it.effect(
  "forged retry content, malformed events, duplicate IDs, and capacity overflow never dispatch",
  () =>
    Effect.gen(function* () {
      let calls = 0
      const actor = yield* createEffectActor(
        uploadsMachine(
          () =>
            Effect.sync(() => {
              calls++
              return file
            }),
          () => Effect.void
        )
      )
      const input = request()
      yield* send(actor, {
        type: "START",
        requests: [{ ...input, file: {} }],
        capacity: 4,
        retry: false,
        reply: yield* Deferred.make<void>(),
      } as never)
      for (const [requests, capacity, retry] of [
        [[input], 4, true],
        [[input, input], 4, false],
        [[input], 0, false],
      ] as const) {
        const reply = yield* Deferred.make<void>()
        yield* send(actor, { type: "START", requests, capacity, retry, reply })
        yield* Deferred.await(reply)
      }
      expect(calls).toBe(0)
      expect(actor.getSnapshot().matches("idle")).toBe(true)
    }).pipe(Effect.scoped)
)

it.effect(
  "empty and oversized files fail locally without consuming a server reservation",
  () =>
    Effect.gen(function* () {
      let calls = 0
      const actor = yield* createEffectActor(
        uploadsMachine(
          () =>
            Effect.sync(() => {
              calls++
              return file
            }),
          () => Effect.void
        )
      )
      const reply = yield* Deferred.make<void>()
      yield* send(actor, {
        type: "START",
        requests: [
          { ...request(), file: new File([], "empty.txt") },
          {
            ...request(),
            id: "large",
            file: new File([new Uint8Array(8 * 1024 * 1024 + 1)], "large.txt"),
          },
        ],
        capacity: 4,
        retry: false,
        reply,
      })
      yield* Deferred.await(reply)
      expect(calls).toBe(0)
      expect(
        actor.getSnapshot().context.attempts.map((item) => item.status)
      ).toEqual(["failed", "failed"])
    }).pipe(Effect.scoped)
)

it.effect(
  "a successful batch publishes sequentially and retires only its exact attempts",
  () =>
    Effect.gen(function* () {
      const ids: string[] = []
      const actor = yield* createEffectActor(
        uploadsMachine(
          (attempt) => Effect.succeed({ ...file, id: attempt.id }),
          (attempt) =>
            Effect.sync(() => {
              ids.push(attempt.id)
            })
        )
      )
      const reply = yield* Deferred.make<void>()
      yield* send(actor, {
        type: "START",
        requests: [
          request(),
          { ...request(), id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
        ],
        capacity: 4,
        retry: false,
        reply,
      })
      yield* Deferred.await(reply)
      expect(ids).toEqual([file.id, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"])
      expect(actor.getSnapshot().context.attempts).toEqual([])
    }).pipe(Effect.scoped)
)

it.effect(
  "an old refresh cannot erase a committed upload; coalesced refresh waits for the fresh read",
  () =>
    Effect.gen(function* () {
      const old = yield* Deferred.make<readonly FileInfo[]>(),
        fresh = yield* Deferred.make<readonly FileInfo[]>(),
        began = yield* Deferred.make<void>()
      const cache = makeFilesCache([])
      let reads = 0
      const actor = yield* createEffectActor(
        fileRefreshMachine(
          () =>
            Effect.suspend(() => {
              reads++
              return reads === 1
                ? Deferred.succeed(began, undefined).pipe(
                    Effect.andThen(Deferred.await(old))
                  )
                : Deferred.await(fresh)
            }),
          cache.replace,
          ({ file, attach }) => cache.uploaded(file, attach)
        )
      )
      yield* Deferred.await(began)
      const committed = yield* Deferred.make<void>(),
        refreshed = yield* Deferred.make<void>()
      yield* send(actor, {
        type: "COMMIT",
        file,
        mode: "upload",
        attach: true,
        reply: committed,
      })
      yield* Deferred.await(committed)
      yield* send(actor, { type: "REFRESH", reply: refreshed })
      yield* waitFor(actor, (state) => state.context.waiters.length === 1)
      yield* Deferred.succeed(old, [])
      yield* Effect.yieldNow
      expect(cache.read().files).toEqual([file])
      expect(cache.read().selected).toEqual([file])
      yield* Deferred.succeed(fresh, [file])
      yield* Deferred.await(refreshed)
      expect(reads).toBe(2)
      expect(cache.read().files).toEqual([file])
    }).pipe(Effect.scoped)
)

it.effect(
  "scope closure aborts and joins a late upload without publishing into either owner",
  () =>
    Effect.gen(function* () {
      let release!: (value: FileInfo) => void,
        aborted = false,
        joined = false
      const native = new Promise<FileInfo>((resolve) => {
        release = resolve
      })
      const started = yield* Deferred.make<void>()
      const old = makeFilesCache([]),
        current = makeFilesCache([{ ...file, name: "current.txt" }])
      const scope = yield* Scope.make()
      const actor = yield* createEffectActor(
        uploadsMachine(
          () =>
            nativeOperation(
              (signal) => {
                signal.addEventListener("abort", () => {
                  aborted = true
                })
                Effect.runSync(Deferred.succeed(started, undefined))
                return native
              },
              (cause) => cause
            ),
          (_, value) => Effect.sync(() => old.uploaded(value, true))
        )
      ).pipe(Scope.provide(scope))
      yield* send(actor, {
        type: "START",
        requests: [request()],
        capacity: 4,
        retry: false,
        reply: yield* Deferred.make<void>(),
      })
      yield* Deferred.await(started)
      const closing = yield* Effect.forkChild(
        Scope.close(scope, Exit.void).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              joined = true
            })
          )
        )
      )
      yield* Effect.yieldNow
      expect(aborted).toBe(true)
      expect(joined).toBe(false)
      release(file)
      yield* Fiber.join(closing)
      expect(joined).toBe(true)
      expect(old.read().files).toEqual([])
      expect(current.read().selected[0]!.name).toBe("current.txt")
    })
)

it.effect(
  "file mutation admits one request, publishes exact result, and returns actionable failure",
  () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<FileInfo, Error>(),
        started = yield* Deferred.make<void>()
      let calls = 0
      const applied: FileInfo[] = []
      const actor = yield* createEffectActor(
        fileMutationMachine(
          () =>
            Effect.sync(() => {
              calls++
            }).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(gate))
            ),
          (value) =>
            Effect.sync(() => {
              applied.push(value)
            })
        )
      )
      const first = yield* Deferred.make<boolean>(),
        duplicate = yield* Deferred.make<boolean>()
      yield* send(actor, {
        type: "MUTATE",
        id: file.id,
        action: "trash",
        name: undefined,
        reply: first,
      })
      yield* Deferred.await(started)
      yield* send(actor, {
        type: "MUTATE",
        id: file.id,
        action: "rename",
        name: "late",
        reply: duplicate,
      })
      expect(yield* Deferred.await(duplicate)).toBe(false)
      yield* Deferred.fail(gate, new Error("Connection interrupted"))
      expect(yield* Deferred.await(first)).toBe(false)
      expect(calls).toBe(1)
      expect(applied).toEqual([])
      expect(actor.getSnapshot().context.error).toBe("Connection interrupted")
    }).pipe(Effect.scoped)
)

it.effect(
  "refresh failure is actionable and malformed mutation cannot reach transport",
  () =>
    Effect.gen(function* () {
      const actor = yield* createEffectActor(
        fileRefreshMachine(
          () => Effect.fail(new Error("Offline")),
          () => {},
          () => {}
        )
      )
      yield* waitFor(actor, (state) => state.matches("idle"))
      expect(actor.getSnapshot().context.error).toBe("Offline")
      let calls = 0
      const mutate = yield* createEffectActor(
        fileMutationMachine(
          () =>
            Effect.sync(() => {
              calls++
              return file
            }),
          () => Effect.void
        )
      )
      yield* send(mutate, {
        type: "MUTATE",
        id: file.id,
        action: "delete-everything",
        name: undefined,
        reply: yield* Deferred.make<boolean>(),
      } as never)
      yield* Effect.yieldNow
      expect(calls).toBe(0)
    }).pipe(Effect.scoped)
)

it.effect(
  "preparation observations serialize and recover automatically after four transient failures at the original two-second cadence",
  () =>
    Effect.gen(function* () {
      let calls = 0,
        fail = false
      const pending: FileInfo = {
        ...file,
        mime: "application/pdf",
        kind: "document",
        extraction: {
          status: "pending",
          pages: 0,
          readPages: 0,
          characters: 0,
          truncated: false,
          error: null,
        },
      }
      const actor = yield* createEffectActor(
        fileRefreshMachine(
          () =>
            Effect.suspend(() => {
              calls++
              return fail
                ? Effect.fail(new Error("Offline"))
                : Effect.succeed([pending])
            }),
          () => {},
          () => {}
        )
      )
      yield* waitFor(actor, (state) => state.matches("waiting"))
      fail = true
      for (let attempt = 1; attempt <= 4; attempt++) {
        yield* TestClock.adjust(2000)
        yield* waitFor(
          actor,
          (state) =>
            state.context.failures === attempt && !state.matches("loading")
        )
      }
      expect(calls).toBe(5)
      expect(actor.getSnapshot().matches("waiting")).toBe(true)
      fail = false
      yield* TestClock.adjust(1999)
      expect(calls).toBe(5)
      yield* TestClock.adjust(1)
      yield* waitFor(actor, (state) => state.context.failures === 0)
      expect(calls).toBe(6)
      expect(actor.getSnapshot().context.failures).toBe(0)
    }).pipe(Effect.scoped)
)

it.effect(
  "the real file owner reports the full late native cleanup Cause after abort and join",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make(),
        started = yield* Deferred.make<void>(),
        aborted = yield* Deferred.make<void>()
      let reject!: (cause: unknown) => void
      const original = globalThis.fetch
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          globalThis.fetch = (input, options) =>
            String(input).includes("/upload")
              ? new Promise((_, fail) => {
                  reject = fail
                  options!.signal!.addEventListener("abort", () =>
                    Effect.runSync(Deferred.succeed(aborted, undefined))
                  )
                  Effect.runSync(Deferred.succeed(started, undefined))
                })
              : Promise.resolve(Response.json({ files: [] }))
        }),
        () =>
          Effect.sync(() => {
            globalThis.fetch = original
          })
      )
      const owner = yield* makeFilesOwner("alpha", makeFilesCache([])).pipe(
        Scope.provide(scope)
      )
      const upload = yield* Effect.forkChild(
        owner.upload([new File(["a"], "proof.txt")], true)
      )
      yield* Deferred.await(started)
      const closing = yield* Effect.forkChild(
        Effect.exit(Scope.close(scope, Exit.void))
      )
      yield* Deferred.await(aborted)
      expect(closing.pollUnsafe()).toBeUndefined()
      const defect = new Error("late cleanup defect")
      const interruption = Cause.interrupt(77123)
      reject(
        Cause.fromReasons([
          ...Cause.fail("late typed fault").reasons,
          ...Cause.die(defect).reasons,
          ...interruption.reasons,
        ])
      )
      const result = yield* Fiber.join(closing)
      yield* Fiber.join(upload)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(result.cause.reasons).toContainEqual(
          expect.objectContaining({ _tag: "Die", defect })
        )
        expect(result.cause.reasons).toContainEqual(
          expect.objectContaining({ _tag: "Interrupt", fiberId: 77123 })
        )
        expect(Cause.pretty(result.cause)).toContain("late typed fault")
      }
    }).pipe(Effect.scoped)
)

for (const phase of ["idle", "loading"] as const) {
  it.effect(
    `a pending commit during ${phase} retains pending preparation through four failed reads after an empty inventory`,
    () =>
      Effect.gen(function* () {
        let calls = 0,
          healthy = false
        const old = yield* Deferred.make<readonly FileInfo[]>()
        const pending: FileInfo = {
          ...file,
          mime: "application/pdf",
          kind: "document",
          extraction: {
            status: "pending",
            pages: 0,
            readPages: 0,
            characters: 0,
            truncated: false,
            error: null,
          },
        }
        const cache = makeFilesCache([])
        const actor = yield* createEffectActor(
          fileRefreshMachine(
            () =>
              Effect.suspend(() => {
                calls++
                if (calls === 1)
                  return phase === "loading"
                    ? Deferred.await(old)
                    : Effect.succeed([])
                return healthy
                  ? Effect.succeed([])
                  : Effect.fail(new Error("Transient list failure"))
              }),
            cache.replace,
            ({ file, attach }) => cache.uploaded(file, attach)
          )
        )
        if (phase === "idle")
          yield* waitFor(actor, (state) => state.matches("idle"))
        else yield* Effect.yieldNow
        const committed = yield* Deferred.make<void>()
        yield* send(actor, {
          type: "COMMIT",
          file: pending,
          mode: phase === "idle" ? "upload" : "update",
          attach: true,
          reply: committed,
        })
        yield* Deferred.await(committed)
        if (phase === "loading") yield* Deferred.succeed(old, [])
        yield* waitFor(
          actor,
          (state) => state.matches("waiting") && state.context.failures === 1
        )
        expect(cache.read().files).toEqual([pending])
        for (let attempt = 2; attempt <= 4; attempt++) {
          yield* TestClock.adjust(2000)
          yield* waitFor(
            actor,
            (state) =>
              state.context.failures === attempt && !state.matches("loading")
          )
        }
        expect(calls).toBe(5)
        expect(actor.getSnapshot().matches("waiting")).toBe(true)
        healthy = true
        yield* TestClock.adjust(1999)
        expect(calls).toBe(5)
        yield* TestClock.adjust(1)
        yield* waitFor(actor, (state) => state.matches("idle"))
        expect(calls).toBe(6)
        expect(actor.getSnapshot().context.preparing).toBe(false)
        expect(cache.read().files).toEqual([])
      }).pipe(Effect.scoped)
  )
}
