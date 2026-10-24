import { Cause, Context, Effect, Exit, Scope } from "effect"
import { afterEach, expect, it, vi } from "vitest"
import { initialTransition, transition } from "xstate"

import { makeModelDefaults } from "../src/features/conversation/model-defaults-owner"
import { modelDefaultsMachine } from "../src/features/conversation/model-defaults.machine"
import { agentApi } from "../src/http/client"
import { resolveRoute } from "../src/inference/policy"

function gate<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const selection = {
  model: "gpt-6.1-sol",
  thinking: "medium" as const,
  settingsRevision: 0,
}
const changed = { model: selection.model, thinking: "high" as const }
const receipt = { ...changed, settingsRevision: 1 }
const catalog = (
  thinking: "high" | "medium" | "low" = "high",
  revision = 1
) => ({
  models: [],
  checkedAt: null,
  error: null,
  usage: "ChatGPT plan usage" as const,
  selection: { ...selection, thinking, settingsRevision: revision },
  assignments: {
    conversation: resolveRoute("conversation", { ...selection, thinking }),
  },
})
function open(
  overrides: Partial<Parameters<typeof makeModelDefaults>[1]> = {}
) {
  const scope = Effect.runSync(Scope.make())
  const ports: Parameters<typeof makeModelDefaults>[1] = {
    authorized: () => true,
    cancel: vi.fn(async () => undefined),
    write: vi.fn(async () => receipt),
    acknowledge: vi.fn(),
    refresh: vi.fn(async () => catalog()),
    ...overrides,
  }
  const owner = Effect.runSync(
    makeModelDefaults({ agentId: "a", selection }, ports).pipe(
      Scope.provide(scope)
    )
  )
  return {
    ...owner,
    ports,
    close: () => {
      owner.revoke()
      return Effect.runPromiseExit(Scope.close(scope, Exit.void))
    },
  }
}
const ready = (owner: ReturnType<typeof open>) =>
  vi.waitFor(() =>
    expect(owner.actor.getSnapshot().matches("ready")).toBe(true)
  )
const edit = async (owner: ReturnType<typeof open>) => {
  owner.actor.send({ type: "CHANGE", draft: changed })
  await vi.waitFor(() =>
    expect(owner.actor.getSnapshot().context.dirty).toBe(true)
  )
}
afterEach(() => vi.unstubAllGlobals())

it("admits one immutable write from same-turn duplicate Save events", async () => {
  const cancelled = gate<void>()
  const owner = open({
    cancel: vi
      .fn()
      .mockImplementationOnce(() => cancelled.promise)
      .mockResolvedValue(undefined),
  })
  try {
    await edit(owner)
    const first = owner.actor.send({ type: "SAVE" }),
      duplicate = owner.actor.send({ type: "SAVE" })
    await Promise.all([first, duplicate])
    await vi.waitFor(() => expect(owner.ports.cancel).toHaveBeenCalledTimes(1))
    expect(owner.ports.write).not.toHaveBeenCalled()
    cancelled.resolve()
    await ready(owner)
    expect(owner.ports.write).toHaveBeenCalledTimes(1)
    expect(owner.ports.write).toHaveBeenCalledWith(
      {
        agentId: "a",
        job: "conversation",
        draft: changed,
        settingsRevision: 0,
        editRevision: 1,
      },
      expect.any(AbortSignal)
    )
    expect(owner.ports.acknowledge).toHaveBeenCalledTimes(1)
    expect(owner.actor.getSnapshot().context.saved).toBe(true)
  } finally {
    cancelled.resolve()
    await owner.close()
  }
})

it("a failed SDK cancellation releases admission without entering HTTP or losing the draft", async () => {
  const owner = open({
    cancel: async () => {
      throw new Error("Query cancellation failed")
    },
  })
  try {
    await edit(owner)
    await owner.actor.send({ type: "SAVE" })
    await vi.waitFor(() =>
      expect(owner.actor.getSnapshot().context.error).toBe(
        "Query cancellation failed"
      )
    )
    await ready(owner)
    expect(owner.ports.write).not.toHaveBeenCalled()
    expect(owner.actor.getSnapshot().context).toMatchObject({
      draft: changed,
      dirty: true,
      attempt: null,
      error: "Query cancellation failed",
    })
  } finally {
    await owner.close()
  }
})

it("late acknowledgement belongs to its captured job and cannot clear a newer draft", async () => {
  const held = gate<unknown>(),
    owner = open({ write: vi.fn(() => held.promise) })
  try {
    await owner.actor.send({
      type: "JOB",
      job: "planning",
      draft: { model: "gpt-6-astra", thinking: "high" },
      settingsRevision: 0,
    })
    await owner.actor.send({
      type: "CHANGE",
      draft: { model: "gpt-6-astra", thinking: "max" },
    })
    await owner.actor.send({ type: "SAVE" })
    await vi.waitFor(() => expect(owner.ports.write).toHaveBeenCalledTimes(1))
    await owner.actor.send({
      type: "CHANGE",
      draft: { model: "gpt-6-astra", thinking: "low" },
    })
    held.resolve(receipt)
    await ready(owner)
    expect(owner.ports.acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({
        job: "planning",
        draft: { model: "gpt-6-astra", thinking: "max" },
      }),
      receipt
    )
    expect(owner.actor.getSnapshot().context).toMatchObject({
      draft: { model: "gpt-6-astra", thinking: "low" },
      dirty: true,
      saved: false,
    })
  } finally {
    held.resolve(receipt)
    await owner.close()
  }
})

it("uncertain writes require an explicit read and never replay on duplicate Save or failed checks", async () => {
  const owner = open({
    write: vi.fn(async () => {
      throw new Error("Response lost")
    }),
    refresh: vi.fn(async () => {
      throw new Error("Read unavailable")
    }),
  })
  try {
    await edit(owner)
    await owner.actor.send({ type: "SAVE" })
    await vi.waitFor(() =>
      expect(owner.actor.getSnapshot().matches("unconfirmed")).toBe(true)
    )
    await owner.actor.send({ type: "SAVE" })
    expect(owner.ports.write).toHaveBeenCalledTimes(1)
    expect(owner.ports.refresh).not.toHaveBeenCalled()
    await owner.actor.send({ type: "CHECK" })
    await vi.waitFor(() => expect(owner.ports.refresh).toHaveBeenCalledTimes(1))
    await vi.waitFor(() =>
      expect(owner.actor.getSnapshot().matches("unconfirmed")).toBe(true)
    )
    expect(owner.ports.refresh).toHaveBeenCalledTimes(1)
    expect(owner.ports.write).toHaveBeenCalledTimes(1)
    expect(owner.actor.getSnapshot().context.attempt?.draft).toEqual(changed)
  } finally {
    await owner.close()
  }
})

it("an explicit observation confirms the current intended value without another write", async () => {
  const owner = open({
    write: vi.fn(async () => {
      throw new Error("Response lost")
    }),
  })
  try {
    await edit(owner)
    await owner.actor.send({ type: "SAVE" })
    await vi.waitFor(() =>
      expect(owner.actor.getSnapshot().matches("unconfirmed")).toBe(true)
    )
    await owner.actor.send({ type: "CHECK" })
    await ready(owner)
    expect(owner.ports.write).toHaveBeenCalledTimes(1)
    expect(owner.ports.acknowledge).toHaveBeenCalledTimes(1)
    expect(owner.actor.getSnapshot().context).toMatchObject({
      dirty: false,
      saved: true,
      accepted: receipt,
    })
  } finally {
    await owner.close()
  }
})

it("a differing observation retains the draft and requires a new explicit Save", async () => {
  const write = vi
    .fn()
    .mockRejectedValueOnce(new Error("Response lost"))
    .mockResolvedValue(receipt)
  const owner = open({
    write,
    refresh: vi.fn(async () => catalog("medium", 2)),
  })
  try {
    await edit(owner)
    await owner.actor.send({ type: "SAVE" })
    await vi.waitFor(() =>
      expect(owner.actor.getSnapshot().matches("unconfirmed")).toBe(true)
    )
    await owner.actor.send({ type: "CHECK" })
    await ready(owner)
    expect(write).toHaveBeenCalledTimes(1)
    expect(owner.actor.getSnapshot().context).toMatchObject({
      dirty: true,
      draft: changed,
      attempt: null,
    })
    expect(owner.actor.getSnapshot().context.error).toContain(
      "Saved settings differ"
    )
  } finally {
    await owner.close()
  }
})

it("refresh failure after acknowledgement retains accepted state and retries only the read", async () => {
  const refresh = vi
    .fn()
    .mockRejectedValueOnce(new Error("Catalog unavailable"))
    .mockResolvedValue(catalog())
  const owner = open({ refresh })
  try {
    await edit(owner)
    await owner.actor.send({ type: "SAVE" })
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    await ready(owner)
    expect(owner.actor.getSnapshot().context).toMatchObject({
      dirty: false,
      saved: true,
      accepted: receipt,
    })
    expect(owner.actor.getSnapshot().context.error).toContain("Default saved")
    await owner.actor.send({ type: "REFRESH" })
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
    await ready(owner)
    expect(owner.ports.write).toHaveBeenCalledTimes(1)
    expect(owner.ports.acknowledge).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(2)
  } finally {
    await owner.close()
  }
})

it("agent revocation aborts and joins actual HTTP while fencing late cache and callback work", async () => {
  const held = gate<Response>()
  let signal: AbortSignal | undefined
  vi.stubGlobal(
    "fetch",
    vi.fn((_path, init: RequestInit) => {
      signal = init.signal as AbortSignal
      return held.promise
    })
  )
  const owner = open({
    write: (request, signal) =>
      agentApi(request.agentId)(
        "settings",
        { ...request.draft, job: request.job },
        signal
      ),
  })
  await edit(owner)
  await owner.actor.send({ type: "SAVE" })
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  let closed = false
  const closing = owner.close().then((exit) => {
    closed = true
    return exit
  })
  await vi.waitFor(() => expect(signal?.aborted).toBe(true))
  expect(closed).toBe(false)
  held.resolve(Response.json(receipt))
  await closing
  expect(owner.ports.acknowledge).not.toHaveBeenCalled()
  expect(owner.ports.refresh).not.toHaveBeenCalled()
})

it("joined shutdown preserves complete annotated native failure without requiring a Die", async () => {
  class NativeSave extends Context.Service<NativeSave, string>()(
    "ModelDefaultNativeSave"
  ) {}
  const cause = Cause.fromReasons([
    Cause.makeFailReason("save failed").annotate(
      Context.make(NativeSave, "save")
    ),
    Cause.makeInterruptReason(81290).annotate(Context.make(NativeSave, "save")),
  ])
  const held = gate<unknown>(),
    owner = open({ write: vi.fn(() => held.promise) })
  await edit(owner)
  await owner.actor.send({ type: "SAVE" })
  await vi.waitFor(() => expect(owner.ports.write).toHaveBeenCalledTimes(1))
  const closing = owner.close()
  held.reject(cause)
  const exit = await closing
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(
      exit.cause.reasons.some(
        (reason) =>
          reason._tag === "Interrupt" &&
          reason.fiberId === 81290 &&
          reason.annotations.get(NativeSave.key) === "save"
      )
    ).toBe(true)
    expect(
      exit.cause.reasons.some(
        (reason) =>
          reason._tag === "Die" &&
          typeof reason.defect === "object" &&
          reason.defect !== null &&
          "error" in reason.defect &&
          reason.defect.error === "save failed"
      )
    ).toBe(true)
  }
})

it("runtime event validation rejects malformed drafts before any transition", () => {
  const machine = modelDefaultsMachine({
    cancel: () => Effect.never,
    write: () => Effect.never,
    acknowledge: () => Effect.never,
    refresh: () => Effect.never,
  })
  const [state] = initialTransition(machine, { agentId: "a", selection })
  const [same, effects] = transition(machine, state, {
    type: "CHANGE",
    draft: { model: "x", thinking: "invalid" },
  } as never)
  expect(same).toBe(state)
  expect(effects).toMatchObject([
    { type: "@xstate.deadLetter", reason: "invalidEvent" },
  ])
})
