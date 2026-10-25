import { it } from "@effect/vitest"
import { send, waitFor } from "@xstate/effect"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { expect, test } from "vitest"

import { homeAgentId } from "../src/agents/domain"
import { makeChannelSettings } from "../src/features/channel-settings/settings-owner"
import {
  settingsRequestKey,
  settingsRequests,
} from "../src/features/channel-settings/settings-request"
import type {
  SettingsChange,
  SettingsView,
} from "../src/features/channel-settings/settings.machine"
import { ApiError } from "../src/http/client"
import { nativeOperation } from "../src/shared/interop"

const id = "12345678-1234-4234-a234-123456789abc"
const input = { channel: "email" as const, archived: false, open: true }
const view = {
  configured: true,
  enabled: true,
  revision: 1,
  address: "private@example.invalid",
  messages: [
    {
      id,
      subject: "Synthetic",
      state: "uncertain" as const,
      error: null,
      createdAt: 1,
    },
  ],
}
const configure: SettingsChange = {
  path: "configure",
  body: { enabled: false, revision: 1, operationId: id },
}
const retry: SettingsChange = {
  path: "retry",
  body: { id, operationId: id, acknowledgeDuplicateRisk: false },
}
function storage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}

it.effect(
  "requires explicit duplicate-risk confirmation and admits one exact request",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      const calls: SettingsChange[] = []
      const actor = yield* makeChannelSettings(input, {
        restore: Effect.succeed(null),
        read: Effect.succeed(view),
        definitive: () => false,
        change: (request) =>
          Effect.sync(() => {
            calls.push(request)
          }).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Deferred.await(release)),
            Effect.as(view)
          ),
      })
      yield* waitFor(actor, (state) => state.matches("ready"))
      yield* send(actor, {
        type: "CHANGE",
        request: {
          path: "retry",
          body: { ...retry.body, acknowledgeDuplicateRisk: true },
        },
      })
      yield* send(actor, { type: "CHANGE", request: retry })
      yield* waitFor(actor, (state) => state.matches("confirming"))
      expect(calls).toEqual([])
      yield* send(actor, { type: "CANCEL" })
      yield* waitFor(actor, (state) => state.matches("ready"))
      expect(calls).toEqual([])
      yield* send(actor, { type: "CHANGE", request: retry })
      yield* waitFor(actor, (state) => state.matches("confirming"))
      yield* send(actor, { type: "CONFIRM" })
      yield* Deferred.await(entered)
      yield* send(actor, { type: "CONFIRM" })
      yield* send(actor, { type: "CHANGE", request: configure })
      yield* send(actor, { type: "RETRY" })
      yield* Effect.yieldNow
      expect(calls).toEqual([
        {
          path: "retry",
          body: { ...retry.body, acknowledgeDuplicateRisk: true },
        },
      ])
      yield* Deferred.succeed(release, undefined)
      yield* waitFor(actor, (state) => state.matches("ready"))
    }).pipe(Effect.scoped)
)

it.effect(
  "retains uncertain identity across refresh and ignores a new save until explicit same-request retry",
  () =>
    Effect.gen(function* () {
      const calls: SettingsChange[] = []
      const actor = yield* makeChannelSettings(input, {
        restore: Effect.succeed(null),
        read: Effect.succeed(view),
        definitive: () => false,
        change: (request) =>
          Effect.suspend(() => {
            calls.push(request)
            return calls.length === 1
              ? Effect.fail(new Error("offline"))
              : Effect.succeed({ ...view, revision: 2 })
          }),
      })
      yield* waitFor(actor, (state) => state.matches("ready"))
      yield* send(actor, { type: "CHANGE", request: configure })
      yield* waitFor(actor, (state) => state.matches("unconfirmed"))
      yield* send(actor, {
        type: "CHANGE",
        request: {
          ...configure,
          body: { ...configure.body, operationId: crypto.randomUUID() },
        },
      })
      yield* send(actor, { type: "REFRESH" })
      yield* waitFor(actor, (state) => state.matches("unconfirmed"))
      expect(calls).toEqual([configure])
      expect(actor.getSnapshot().context.request).toEqual(configure)
      yield* send(actor, { type: "RETRY" })
      yield* waitFor(
        actor,
        (state) => state.matches("ready") && state.context.view?.revision === 2
      )
      expect(calls).toEqual([configure, configure])
    }).pipe(Effect.scoped)
)

for (const channel of ["email", "whatsapp"] as const) {
  test(`${channel} restores exact request without dispatch and separates users and agents`, async () => {
    const saved = storage(),
      bodies: unknown[] = []
    const response: SettingsView =
      channel === "email"
        ? view
        : {
            configured: true,
            enabled: true,
            revision: 1,
            agentId: homeAgentId,
            agentName: "Navi",
            contactUrl: null,
            messages: [],
          }
    const work = settingsRequests(
      channel,
      "owner",
      "home",
      saved,
      async (_path, body) => {
        bodies.push(body)
        throw new ApiError(503, "unconfirmed")
      },
      () => true
    )
    await Effect.runPromiseExit(work.change(configure))
    expect(await Effect.runPromise(work.restore)).toEqual(configure)
    const recreated = settingsRequests(
      channel,
      "owner",
      "home",
      saved,
      async (_path, body) => {
        bodies.push(body)
        return response
      },
      () => true
    )
    expect(await Effect.runPromise(recreated.restore)).toEqual(configure)
    expect(bodies).toEqual([configure.body])
    expect(
      await Effect.runPromise(
        settingsRequests(
          channel,
          "different",
          "home",
          saved,
          async () => response,
          () => true
        ).restore
      )
    ).toBeNull()
    expect(
      await Effect.runPromise(
        settingsRequests(
          channel,
          "owner",
          "other",
          saved,
          async () => response,
          () => true
        ).restore
      )
    ).toBeNull()
    await Effect.runPromise(recreated.change(configure))
    expect(bodies).toEqual([configure.body, configure.body])
    expect(await Effect.runPromise(recreated.restore)).toBeNull()
  })
}

test("storage failure prevents dispatch; a stale completion cannot erase a replacement receipt", async () => {
  const saved = storage()
  let calls = 0,
    release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const work = settingsRequests(
    "email",
    "owner",
    "home",
    saved,
    async () => {
      calls++
      await held
      return view
    },
    () => true
  )
  const failed = settingsRequests(
    "email",
    "owner",
    "home",
    {
      ...saved,
      setItem: () => {
        throw new Error("quota")
      },
    },
    async () => {
      calls++
      return view
    },
    () => true
  )
  expect(
    Exit.isFailure(await Effect.runPromiseExit(failed.change(configure)))
  ).toBe(true)
  expect(calls).toBe(0)
  const pending = Effect.runPromise(work.change(configure))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  const replacement = {
    ...configure,
    body: { ...configure.body, operationId: crypto.randomUUID() },
  }
  saved.setItem(
    settingsRequestKey("owner", "home", "email"),
    JSON.stringify({ version: 1, request: replacement })
  )
  release()
  await pending
  expect(await Effect.runPromise(work.restore)).toEqual(replacement)
})

it.effect(
  "scope closure joins held native work and retains late fatal cleanup",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      class RequestId extends Context.Service<RequestId, string>()(
        "ChannelSettingsCleanup"
      ) {}
      const cause = Cause.fromReasons([
        Cause.makeFailReason("late checked"),
        Cause.makeDieReason("late defect").annotate(
          Context.make(RequestId, "original request")
        ),
        Cause.makeInterruptReason(82234),
      ])
      const actor = yield* makeChannelSettings(input, {
        restore: Effect.succeed(null),
        read: Effect.succeed(view),
        definitive: () => false,
        change: () =>
          nativeOperation(
            () =>
              Effect.runPromiseExit(
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(Effect.failCause(cause))
                )
              ).then((exit) => {
                if (Exit.isFailure(exit)) throw exit.cause
                return exit.value
              }),
            (error) => error
          ),
      }).pipe(Effect.provideService(Scope.Scope, scope))
      yield* waitFor(actor, (state) => state.matches("ready"))
      yield* send(actor, { type: "CHANGE", request: configure })
      yield* Deferred.await(entered)
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.exit,
        Effect.forkChild
      )
      yield* Effect.yieldNow
      expect(closing.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      const exit = yield* Fiber.join(closing)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit))
        expect(Cause.pretty(exit.cause)).toContain("late defect")
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("late checked")
        expect(exit.cause.reasons).toContainEqual(
          expect.objectContaining({ _tag: "Interrupt", fiberId: 82234 })
        )
        expect(
          exit.cause.reasons
            .find(
              (reason) =>
                reason._tag === "Die" && reason.defect === "late defect"
            )
            ?.annotations.get(RequestId.key)
        ).toBe("original request")
      }
    }).pipe(Effect.scoped)
)

it.effect("archival and malformed requests cannot authorize a resend", () =>
  Effect.gen(function* () {
    let calls = 0
    const actor = yield* makeChannelSettings(input, {
      restore: Effect.succeed(null),
      read: Effect.succeed(view),
      definitive: () => false,
      change: () =>
        Effect.sync(() => {
          calls++
          return view
        }),
    })
    yield* waitFor(actor, (state) => state.matches("ready"))
    yield* send(actor, { type: "CHANGE", request: retry })
    yield* waitFor(actor, (state) => state.matches("confirming"))
    yield* send(actor, { type: "AUTHORITY", open: true, archived: true })
    yield* send(actor, { type: "CONFIRM" })
    yield* send(actor, { type: "CANCEL" })
    yield* send(actor, {
      type: "CHANGE",
      request: {
        path: "configure",
        body: { enabled: true, revision: 1, operationId: id },
      },
    })
    yield* send(actor, { type: "CHANGE", request: null } as never)
    yield* Effect.yieldNow
    expect(calls).toBe(0)
  }).pipe(Effect.scoped)
)

it.effect("a superseded refresh cannot overwrite the acknowledged save", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>(),
      release = yield* Deferred.make<void>()
    let reads = 0,
      changes = 0
    const actor = yield* makeChannelSettings(input, {
      restore: Effect.succeed(null),
      definitive: () => false,
      read: Effect.suspend(() =>
        ++reads === 1
          ? Effect.succeed(view)
          : Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ ...view, revision: 99 }),
              Effect.uninterruptible
            )
      ),
      change: () =>
        Effect.sync(() => {
          changes++
          return { ...view, revision: 2, enabled: false }
        }),
    })
    yield* waitFor(actor, (state) => state.matches("ready"))
    yield* send(actor, { type: "REFRESH" })
    yield* Deferred.await(entered)
    yield* send(actor, { type: "CHANGE", request: configure })
    yield* TestClock.adjust(1)
    yield* Deferred.succeed(release, undefined)
    yield* waitFor(actor, (state) => state.matches("ready") && changes === 1)
    expect(actor.getSnapshot().context.view?.revision).toBe(2)
  }).pipe(Effect.scoped)
)

test("compound failure is not a definitive rejection and cannot erase its saved request", async () => {
  const saved = storage()
  const cause = Cause.fromReasons([
    Cause.makeFailReason(new ApiError(409, "conflict")),
    Cause.makeDieReason("storage defect"),
  ])
  const work = settingsRequests(
    "email",
    "owner",
    "home",
    saved,
    async () => {
      throw cause
    },
    () => true
  )
  const exit = await Effect.runPromiseExit(work.change(configure))
  expect(
    Exit.isFailure(exit) && exit.cause.reasons.map((reason) => reason._tag)
  ).toEqual(["Fail", "Die"])
  expect(await Effect.runPromise(work.restore)).toEqual(configure)
  const invalid = settingsRequests(
    "email",
    "owner",
    "home",
    {
      ...saved,
      getItem: () => JSON.stringify({ version: 99, request: configure }),
    },
    async () => view,
    () => true
  )
  expect(Exit.isFailure(await Effect.runPromiseExit(invalid.restore))).toBe(
    true
  )
})

test("definitive rejection keeps its Cause when clearing the saved receipt also fails", async () => {
  const saved = storage()
  const rejection = new ApiError(409, "conflict"),
    cleanup = new Error("storage remove failed")
  const work = settingsRequests(
    "email",
    "owner",
    "home",
    {
      ...saved,
      removeItem: () => {
        throw cleanup
      },
    },
    async () => {
      throw rejection
    },
    () => true
  )
  const exit = await Effect.runPromiseExit(work.change(configure))
  expect(
    Exit.isFailure(exit) &&
      exit.cause.reasons
        .filter((reason) => reason._tag === "Fail")
        .map((reason) => reason.error)
  ).toEqual([rejection, cleanup])
  expect(await Effect.runPromise(work.restore)).toEqual(configure)
})

it.effect(
  "global WhatsApp routing restores and replays the original target after a lost acknowledgement",
  () =>
    Effect.gen(function* () {
      const saved = storage()
      const response = {
        configured: true,
        enabled: true,
        revision: 1,
        agentId: homeAgentId,
        agentName: "Home",
        contactUrl: null,
        messages: [],
      }
      const request: SettingsChange = {
        agentId: "target-agent",
        path: "configure",
        body: { enabled: true, revision: 1, operationId: id },
      }
      const calls: { target: string; path: string; body: unknown }[] = []
      const work = () =>
        settingsRequests(
          "whatsapp",
          "owner",
          "home",
          saved,
          async (path, body) => {
            expect(path).toBe("whatsapp")
            expect(body).toBeUndefined()
            return response
          },
          () => true,
          async (target, path, body) => {
            calls.push({ target, path, body })
            if (calls.length === 1)
              throw new ApiError(503, "acknowledgement lost")
            return response
          }
        )
      const scope = yield* Scope.make()
      const original = yield* makeChannelSettings(
        { ...input, channel: "whatsapp" },
        work()
      ).pipe(Scope.provide(scope))
      yield* waitFor(original, (state) => state.matches("ready"))
      yield* send(original, { type: "CHANGE", request })
      yield* waitFor(original, (state) => state.matches("unconfirmed"))
      expect(original.getSnapshot().context.request).toEqual(request)
      yield* Scope.close(scope, Exit.void)
      const restored = yield* makeChannelSettings(
        { ...input, channel: "whatsapp" },
        work()
      )
      yield* waitFor(restored, (state) => state.matches("unconfirmed"))
      expect(calls).toHaveLength(1)
      yield* send(restored, {
        type: "CHANGE",
        request: { ...request, agentId: "different-agent" },
      })
      yield* send(restored, { type: "RETRY" })
      yield* waitFor(restored, (state) => state.matches("ready"))
      expect(calls).toEqual(
        Array(2).fill({
          target: "target-agent",
          path: "whatsapp/configure",
          body: request.body,
        })
      )
      expect(yield* work().restore).toBeNull()
    }).pipe(Effect.scoped)
)
