import { it as effectIt } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Cause, Effect, Exit, Redacted, Scope } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it, vi } from "vitest"
import { initialTransition, transition } from "xstate"

import { makeFamilyAccess } from "../src/features/family/family-access-owner"
import { makeFamilyChange } from "../src/features/family/family-change-owner"
import { familyChangeMachine } from "../src/features/family/family-change.machine"
import { makeFamilyJoin } from "../src/features/family/family-join-owner"
import { invitationRecord } from "../src/features/family/invitation-record"
import { makeModelSignIn } from "../src/features/family/model-sign-in-owner"
import { modelSignInMachine } from "../src/features/family/model-sign-in.machine"

function gate<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function open<A extends { revoke: () => void }>(
  work: Effect.Effect<A, never, Scope.Scope>
) {
  const scope = Effect.runSync(Scope.make())
  const value = Effect.runSync(
    work.pipe(Effect.provideService(Scope.Scope, scope))
  )
  return {
    ...value,
    close: () => {
      value.revoke()
      return Effect.runPromiseExit(Scope.close(scope, Exit.void))
    },
  }
}
const family = {
  id: "family",
  name: "Family",
  role: "owner" as const,
  ownerName: "Owner",
  members: [],
  invitations: [],
}
const pending = () => ({
  id: "attempt-a",
  email: "a@example.invalid",
  expiresAt: Date.now() + 60_000,
  authorizationUrl: "https://example.invalid/authorize",
})
const invitation = (id: string) => ({
  id,
  email: "member@example.invalid",
  status: "pending" as const,
  familyName: "Family",
  inviterName: "Owner",
})
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))
const ready = (owner: ReturnType<typeof join>) =>
  vi.waitFor(() =>
    expect(owner.actor.getSnapshot().matches("ready")).toBe(true)
  )
function join(overrides: Partial<Parameters<typeof makeFamilyJoin>[0]> = {}) {
  const ports: Parameters<typeof makeFamilyJoin>[0] = {
    verify: vi.fn(async () => undefined),
    locate: vi.fn(async () => "a"),
    preview: vi.fn(async (id) => invitation(id)),
    refresh: vi.fn(async () => undefined),
    session: () => null,
    change: vi.fn(async () => undefined),
    joined: vi.fn(),
    classify: () => ({ unavailable: false, temporary: false }),
    ...overrides,
  }
  return { ...open(makeFamilyJoin(ports)), ports }
}

describe("family access owner", () => {
  it("serializes focus reads and cannot restore stale access after denial", async () => {
    const held = gate<{ type: "ready"; family: typeof family }>()
    const read = vi
      .fn()
      .mockImplementationOnce(() => held.promise)
      .mockResolvedValue({ type: "ended" })
    const owner = open(
      makeFamilyAccess({ read, signOut: async () => undefined, leave: vi.fn() })
    )
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
      owner.inspect()
      owner.inspect()
      await tick()
      expect(read).toHaveBeenCalledTimes(1)
      held.resolve({ type: "ready", family })
      await vi.waitFor(() =>
        expect(owner.actor.getSnapshot().matches("ended")).toBe(true)
      )
      expect(owner.actor.getSnapshot().context.family).toBeNull()
      owner.inspect()
      await tick()
      expect(read).toHaveBeenCalledTimes(2)
    } finally {
      held.resolve({ type: "ready", family })
      await owner.close()
    }
  })
  it("joins a revoked native read and retains its full late compound Cause", async () => {
    const held = gate<never>()
    const defect = { fault: "family-read" }
    let signal!: AbortSignal
    const owner = open(
      makeFamilyAccess({
        read: (value) => {
          signal = value
          return held.promise
        },
        signOut: async () => undefined,
        leave: vi.fn(),
      })
    )
    await vi.waitFor(() => expect(signal).toBeDefined())
    let closed = false
    const closing = owner.close().then((exit) => {
      closed = true
      return exit
    })
    await tick()
    expect(signal.aborted).toBe(true)
    expect(closed).toBe(false)
    held.reject(Cause.combine(Cause.fail("checked"), Cause.die(defect)))
    const exit = await closing
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeDefined()
  })
})

describe("family mutation owner", () => {
  it("admits one command and keeps its accepted result if refresh fails", async () => {
    const held = gate<void>()
    const change = vi.fn(() => held.promise)
    const owner = open(
      makeFamilyChange({
        change,
        authorized: () => true,
        refresh: async () => {
          throw new Error("refresh")
        },
      })
    )
    try {
      owner.actor.send({
        type: "CHANGE",
        command: { kind: "invite", email: "a@example.invalid" },
      })
      owner.actor.send({
        type: "CHANGE",
        command: { kind: "remove", id: "x", name: "Other" },
      })
      await vi.waitFor(() => expect(change).toHaveBeenCalledTimes(1))
      held.resolve()
      await vi.waitFor(() =>
        expect(owner.actor.getSnapshot().matches("idle")).toBe(true)
      )
      expect(owner.actor.getSnapshot().context.notice).toContain(
        "Invitation sent"
      )
    } finally {
      held.resolve()
      await owner.close()
    }
  })
  it("rechecks current authority before dispatch and before accepting a late result", async () => {
    let authorized = true
    const held = gate<void>()
    const change = vi.fn(() => held.promise)
    const owner = open(
      makeFamilyChange({
        change,
        authorized: () => authorized,
        refresh: async () => undefined,
      })
    )
    try {
      owner.actor.send({ type: "CHANGE", command: { kind: "cancel", id: "x" } })
      await vi.waitFor(() => expect(change).toHaveBeenCalledTimes(1))
      authorized = false
      held.resolve()
      await vi.waitFor(() =>
        expect(owner.actor.getSnapshot().matches("idle")).toBe(true)
      )
      expect(owner.actor.getSnapshot().context.notice).toBe("")
      owner.actor.send({ type: "CHANGE", command: { kind: "cancel", id: "x" } })
      await tick()
      expect(change).toHaveBeenCalledTimes(1)
    } finally {
      held.resolve()
      await owner.close()
    }
  })
})

describe("model sign-in owner", () => {
  function model(
    account: Parameters<typeof makeModelSignIn>[0]["account"],
    rest: Partial<Parameters<typeof makeModelSignIn>[0]> = {}
  ) {
    const connected = vi.fn(async () => undefined),
      close = vi.fn(),
      replace = vi.fn()
    return {
      ...open(
        makeModelSignIn({
          account,
          connected,
          authorized: () => true,
          popup: () => ({ close, location: { replace }, opener: null }),
          ...rest,
        })
      ),
      connected,
      closePopup: close,
      replace,
    }
  }
  it("restores expired attempts without permitting exchange", async () => {
    const account = vi.fn(async () => ({
      pending: { ...pending(), expiresAt: 0 },
    }))
    const owner = model(account as Parameters<typeof model>[0])
    try {
      await vi.waitFor(() =>
        expect(owner.actor.getSnapshot().matches("expired")).toBe(true)
      )
      owner.actor.send({ type: "FINISH", address: Redacted.make("secret") })
      await tick()
      expect(account).toHaveBeenCalledTimes(1)
    } finally {
      await owner.close()
    }
  })
  it("an exchange acknowledgement survives a failed catalog refresh", async () => {
    const account = vi.fn(async (body) =>
      body
        ? { status: "connected", email: "saved@example.invalid" }
        : { pending: pending() }
    )
    const owner = model(account as Parameters<typeof model>[0], {
      connected: async () => {
        throw new Error("catalog unavailable")
      },
    })
    try {
      await vi.waitFor(() =>
        expect(owner.actor.getSnapshot().matches("waiting")).toBe(true)
      )
      owner.actor.send({ type: "FINISH", address: Redacted.make("secret") })
      await vi.waitFor(() =>
        expect(owner.actor.getSnapshot().matches({ connected: "ready" })).toBe(
          true
        )
      )
      expect(owner.actor.getSnapshot().context.connected).toBe(
        "saved@example.invalid"
      )
      expect(owner.actor.getSnapshot().context.address).toBeNull()
      expect(account).toHaveBeenCalledTimes(2)
    } finally {
      await owner.close()
    }
  })
  it("uncertain exchange reads status once and cannot exchange a consumed attempt again", async () => {
    let reads = 0
    const account = vi.fn(async (body) => {
      if (body) throw new Error("acknowledgement lost")
      return { pending: reads++ === 0 ? pending() : null }
    })
    const owner = model(account as Parameters<typeof model>[0])
    try {
      await vi.waitFor(() =>
        expect(owner.actor.getSnapshot().matches("waiting")).toBe(true)
      )
      owner.actor.send({ type: "FINISH", address: Redacted.make("secret") })
      await vi.waitFor(() =>
        expect(owner.actor.getSnapshot().matches("expired")).toBe(true)
      )
      owner.actor.send({ type: "FINISH", address: Redacted.make("secret") })
      await tick()
      expect(account).toHaveBeenCalledTimes(3)
    } finally {
      await owner.close()
    }
  })
  it("joins a held exchange and suppresses its late connected callback after revoke", async () => {
    const held = gate<unknown>()
    const account = vi.fn(async (body) =>
      body ? held.promise : { pending: pending() }
    )
    const owner = model(account as Parameters<typeof model>[0])
    await vi.waitFor(() =>
      expect(owner.actor.getSnapshot().matches("waiting")).toBe(true)
    )
    owner.actor.send({ type: "FINISH", address: Redacted.make("secret") })
    await vi.waitFor(() => expect(account).toHaveBeenCalledTimes(2))
    let closed = false
    const closing = owner.close().then(() => {
      closed = true
    })
    await tick()
    expect(closed).toBe(false)
    held.resolve({ status: "connected", email: "a@example.invalid" })
    await closing
    expect(owner.connected).not.toHaveBeenCalled()
  })
  it("closes an owned blank popup and never navigates it after role revocation", async () => {
    let authorized = true
    const held = gate<unknown>()
    const account = vi.fn(async (body) =>
      body ? held.promise : { pending: null }
    )
    const owner = model(account as Parameters<typeof model>[0], {
      authorized: () => authorized,
    })
    try {
      await vi.waitFor(() =>
        expect(owner.actor.getSnapshot().matches("idle")).toBe(true)
      )
      owner.start("a@example.invalid")
      owner.start("duplicate@example.invalid")
      await vi.waitFor(() => expect(account).toHaveBeenCalledTimes(2))
      authorized = false
      held.resolve(pending())
      await vi.waitFor(() => expect(owner.closePopup).toHaveBeenCalledTimes(1))
      expect(owner.replace).not.toHaveBeenCalled()
    } finally {
      held.resolve(pending())
      await owner.close()
    }
  })
})

describe("invitation owner", () => {
  it("retries only one temporary preview and never repeats verification", async () => {
    const preview = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue(invitation("a"))
    const owner = join({
      preview,
      classify: () => ({ temporary: true, unavailable: false }),
    })
    try {
      owner.open("a", "secret-token")
      await ready(owner)
      expect(owner.ports.verify).toHaveBeenCalledTimes(1)
      expect(preview).toHaveBeenCalledTimes(2)
      expect(owner.actor.getSnapshot().context.source.token).toBeNull()
    } finally {
      await owner.close()
    }
  })
  it("exhausts the preview budget and explicit retry does not replay verification", async () => {
    const preview = vi.fn().mockRejectedValue(new Error("temporary"))
    const owner = join({
      preview,
      classify: () => ({ temporary: true, unavailable: false }),
    })
    try {
      owner.open("a", "secret-token")
      await vi.waitFor(() =>
        expect(owner.actor.getSnapshot().matches("failed")).toBe(true)
      )
      expect(preview).toHaveBeenCalledTimes(2)
      preview.mockResolvedValue(invitation("a"))
      owner.actor.send({ type: "RETRY" })
      await ready(owner)
      expect(owner.ports.verify).toHaveBeenCalledTimes(1)
      expect(preview).toHaveBeenCalledTimes(3)
    } finally {
      await owner.close()
    }
  })
  it("holds replacement until prior native work joins and fences late acceptance", async () => {
    const held = gate<void>()
    const change = vi.fn(() => held.promise)
    const owner = join({
      change,
      session: () => ({ email: "member@example.invalid", verified: true }),
    })
    try {
      owner.open("a", null)
      await ready(owner)
      owner.actor.send({
        type: "SESSION",
        pending: false,
        session: { email: "member@example.invalid", verified: true },
      })
      owner.actor.send({ type: "COMMAND", command: { kind: "accept" } })
      await vi.waitFor(() => expect(change).toHaveBeenCalledTimes(1))
      owner.open("b", null)
      await tick()
      expect(owner.ports.preview).toHaveBeenCalledTimes(1)
      held.resolve()
      await ready(owner)
      expect(owner.actor.getSnapshot().context.invitation?.id).toBe("b")
      expect(owner.ports.joined).not.toHaveBeenCalled()
      expect(change).toHaveBeenCalledTimes(1)
    } finally {
      held.resolve()
      await owner.close()
    }
  })
  it("checks latest SDK account again at acceptance dispatch", async () => {
    const owner = join({
      session: () => ({ email: "other@example.invalid", verified: true }),
    })
    try {
      owner.open("a", null)
      await ready(owner)
      owner.actor.send({
        type: "SESSION",
        pending: false,
        session: { email: "member@example.invalid", verified: true },
      })
      owner.actor.send({ type: "COMMAND", command: { kind: "accept" } })
      await tick()
      expect(owner.ports.change).not.toHaveBeenCalled()
      expect(owner.actor.getSnapshot().context.error).toContain(
        "account has changed"
      )
    } finally {
      await owner.close()
    }
  })
  it("a failed session refresh cannot erase confirmed membership acceptance", async () => {
    const owner = join({
      refresh: async () => {
        throw new Error("offline")
      },
      session: () => ({ email: "member@example.invalid", verified: true }),
    })
    try {
      owner.open("a", null)
      await ready(owner)
      owner.actor.send({
        type: "SESSION",
        pending: false,
        session: { email: "member@example.invalid", verified: true },
      })
      owner.actor.send({ type: "COMMAND", command: { kind: "accept" } })
      await vi.waitFor(() =>
        expect(owner.actor.getSnapshot().matches("welcome")).toBe(true)
      )
      expect(owner.ports.joined).toHaveBeenCalledWith("a")
    } finally {
      await owner.close()
    }
  })
})

describe("invitation tab identity compatibility", () => {
  function storage(raw: string | null) {
    return {
      getItem: vi.fn(() => raw),
      setItem: vi.fn((_key: string, value: string) => {
        raw = value
      }),
      removeItem: vi.fn(() => {
        raw = null
      }),
    }
  }
  it("keeps only the invitation id across an authentication redirect", () => {
    const store = storage(null),
      record = invitationRecord(store)
    record.remember("a")
    expect(invitationRecord(store).restore()).toBe("a")
    record.joined("b")
    expect(record.restore()).toBe("a")
    record.joined("a")
    expect(record.restore()).toBeNull()
    expect(store.setItem.mock.calls[0]?.[1]).toBe(
      '{"version":1,"invitation":"a"}'
    )
  })
  it.each(['{"version":2,"invitation":"future"}', "{broken"])(
    "retains unsupported or corrupt state %s",
    (raw) => {
      const store = storage(raw),
        record = invitationRecord(store)
      expect(record.restore()).toBeNull()
      record.remember("new")
      record.joined("new")
      expect(store.setItem).not.toHaveBeenCalled()
      expect(store.removeItem).not.toHaveBeenCalled()
    }
  )
})

it("malformed commands are rejected before any lifecycle transition", () => {
  const models = modelSignInMachine({
    restore: Effect.never,
    start: () => Effect.never,
    finish: () => Effect.never,
    cancel: Effect.never,
    connected: Effect.void,
  })
  const [model] = initialTransition(models)
  const [same, effects] = transition(models, model, {
    type: "FINISH",
    address: "unredacted",
  } as never)
  expect(same).toBe(model)
  expect(effects).toMatchObject([
    { type: "@xstate.deadLetter", reason: "invalidEvent" },
  ])
  const changes = familyChangeMachine({
    change: () => Effect.never,
    refresh: Effect.void,
  })
  const [idle] = initialTransition(changes)
  const [still, rejected] = transition(changes, idle, {
    type: "CHANGE",
    command: { kind: "remove", id: 4, name: "Member" },
  } as never)
  expect(still).toBe(idle)
  expect(rejected).toMatchObject([
    { type: "@xstate.deadLetter", reason: "invalidEvent" },
  ])
})

effectIt.effect(
  "the waiting sign-in expires on the owned clock without an exchange",
  () =>
    Effect.gen(function* () {
      const account = vi.fn(async () => ({
        pending: { ...pending(), expiresAt: 1000 },
      }))
      const owner = yield* makeModelSignIn({
        account: account as Parameters<typeof makeModelSignIn>[0]["account"],
        authorized: () => true,
        connected: async () => undefined,
        popup: () => null,
      })
      yield* waitFor(owner.actor, (state) => state.matches("waiting"))
      yield* TestClock.adjust("1001 millis")
      yield* waitFor(owner.actor, (state) => state.matches("expired"))
      yield* send(owner.actor, {
        type: "FINISH",
        address: Redacted.make("late"),
      })
      expect(account).toHaveBeenCalledTimes(1)
    }).pipe(Effect.scoped)
)

it("membership acceptance cannot navigate after account changes during refresh", async () => {
  let current = { email: "member@example.invalid", verified: true }
  const held = gate<void>()
  const owner = join({ session: () => current, refresh: () => held.promise })
  try {
    owner.open("a", null)
    await ready(owner)
    owner.actor.send({ type: "SESSION", pending: false, session: current })
    owner.actor.send({ type: "COMMAND", command: { kind: "accept" } })
    await vi.waitFor(() =>
      expect(
        owner.actor.getSnapshot().matches({ working: "changedSession" })
      ).toBe(true)
    )
    current = { email: "other@example.invalid", verified: true }
    held.resolve()
    await ready(owner)
    expect(owner.ports.joined).not.toHaveBeenCalled()
  } finally {
    held.resolve()
    await owner.close()
  }
})

effectIt.effect(
  "sign-in errors hold settings navigation until retried or dismissed without reviving an expired attempt",
  () =>
    Effect.gen(function* () {
      let starts = 0
      const attempt = {
        id: "attempt",
        email: "owner@example.invalid",
        expiresAt: 10000,
        authorizationUrl: "https://example.invalid/sign-in",
      }
      const actor = yield* createEffectActor(
        modelSignInMachine({
          restore: Effect.succeed({ ok: true, value: attempt, now: 0 }),
          start: () =>
            Effect.sync(() =>
              ++starts === 1
                ? { ok: false as const, error: "offline", now: 0 }
                : { ok: true as const, value: attempt, now: 0 }
            ),
          finish: () =>
            Effect.succeed({ ok: false, error: "exchange failed", now: 0 }),
          cancel: Effect.succeed({ ok: false, error: "reset failed", now: 0 }),
          connected: Effect.void,
        })
      )
      yield* waitFor(actor, (state) => state.matches("waiting"))
      expect(actor.getSnapshot().context.requestError).toBe(false)
      yield* send(actor, {
        type: "FINISH",
        address: Redacted.make("http://127.0.0.1/callback"),
      })
      yield* waitFor(
        actor,
        (state) => state.matches("waiting") && state.context.requestError
      )
      yield* send(actor, { type: "EDIT" })
      yield* waitFor(actor, (state) => !state.context.requestError)
      expect(actor.getSnapshot().context.error).toBe("")
      yield* send(actor, { type: "CANCEL" })
      yield* waitFor(
        actor,
        (state) => state.matches("expired") && state.context.requestError
      )
      yield* send(actor, { type: "EDIT" })
      yield* waitFor(actor, (state) => !state.context.requestError)
      expect(actor.getSnapshot().matches("expired")).toBe(true)
      expect(actor.getSnapshot().context.attempt?.id).toBe("attempt")
    }).pipe(Effect.scoped)
)
