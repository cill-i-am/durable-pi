import { expect, it } from "vitest"
import { Cause, Context, Effect, Exit, Schema } from "effect"
import { backgroundRemote } from "../src/delegation/adapters/background-rpc"
import {
  BackgroundRequest,
  backgroundReply,
} from "../src/delegation/adapters/background-protocol"
import { DelegationFailure, type Group } from "../src/delegation/contracts"
import { resolveRoute } from "../src/inference/policy"

const expected = new DelegationFailure({
  code: "cancelled",
  message: "This task stopped.",
})
const group: Group = {
  id: 19,
  turnId: "original-turn",
  conversationId: 1,
  objective: "Draft privately",
  route: resolveRoute("conversation", { model: "gpt-6-luna", thinking: "low" }),
  createdAt: 1000,
  deadline: 2000,
  status: "completed",
  children: [],
}

it("routes the five native operations through their schema-defined request and result", async () => {
  const requests: { id: number; request: typeof BackgroundRequest.Type }[] = []
  const remote = backgroundRemote("a".repeat(64), (id) => ({
    invokeV1: async (raw) => {
      const request = Schema.decodeUnknownSync(BackgroundRequest)(raw)
      requests.push({ id, request })
      switch (request._tag) {
        case "Start":
        case "Read":
          return backgroundReply(Exit.succeed(group))
        case "Stop":
          return backgroundReply(Exit.succeed(null))
        case "Control":
          return backgroundReply(Exit.succeed({ accepted: true }))
        case "Transcript":
          return backgroundReply(Exit.succeed({ entries: [], cursor: null }))
      }
    },
  }))
  expect(await Effect.runPromise(remote.start(19))).toEqual(group)
  expect(await Effect.runPromise(remote.read(19))).toEqual(group)
  expect(await Effect.runPromise(remote.stop(19))).toBeUndefined()
  const input = {
    groupId: 19,
    childId: 2,
    operationId: crypto.randomUUID(),
    action: { type: "stop" as const },
  }
  expect(await Effect.runPromise(remote.control(input))).toEqual({
    accepted: true,
  })
  expect(await Effect.runPromise(remote.transcript(19, 2, "cursor"))).toEqual({
    entries: [],
    cursor: null,
  })
  expect(requests).toEqual([
    {
      id: 19,
      request: { _tag: "Start", parentObject: "a".repeat(64), id: 19 },
    },
    { id: 19, request: { _tag: "Read" } },
    { id: 19, request: { _tag: "Stop" } },
    { id: 19, request: { _tag: "Control", input } },
    { id: 19, request: { _tag: "Transcript", child: 2, cursor: "cursor" } },
  ])
})

it.each([
  { name: "expected failure", cause: Cause.fail(expected), tags: ["Fail"] },
  {
    name: "defect",
    cause: Cause.die(new Error("private credential")),
    tags: ["Die"],
  },
  { name: "tagged defect", cause: Cause.die(expected), tags: ["Die"] },
  { name: "interruption", cause: Cause.interrupt(731), tags: ["Interrupt"] },
  {
    name: "mixed Cause",
    cause: Cause.fromReasons([
      Cause.makeFailReason(expected),
      Cause.makeDieReason(new Error("private credential")),
      Cause.makeInterruptReason(731),
    ]),
    tags: ["Fail", "Die", "Interrupt"],
  },
])(
  "preserves $name across a JSON round trip without private diagnostics",
  async ({ cause, tags }) => {
    class PrivateTrace extends Context.Service<PrivateTrace, string>()(
      "PrivateTrace"
    ) {}
    const annotated = Cause.fromReasons(
      cause.reasons.map((reason) =>
        reason.annotate(Context.make(PrivateTrace, "private credential"))
      )
    )
    const reply = backgroundReply(Exit.failCause(annotated))
    const serialized = JSON.stringify(reply)
    expect(serialized).not.toContain("private credential")
    expect(serialized).not.toContain("PrivateTrace")
    const remote = backgroundRemote("a".repeat(64), () => ({
      invokeV1: async () => JSON.parse(serialized),
    }))
    const exit = await Effect.runPromiseExit(remote.read(19))
    expect(
      Exit.isFailure(exit) && exit.cause.reasons.map((reason) => reason._tag)
    ).toEqual(tags)
    if (Exit.isFailure(exit)) {
      for (const reason of exit.cause.reasons) {
        if (reason._tag === "Fail") expect(reason.error).toEqual(expected)
        if (reason._tag === "Interrupt") expect(reason.fiberId).toBe(731)
      }
    }
  }
)

it("encodes the declared failure fields when the local error lost its prototype", async () => {
  const error = new DelegationFailure({
    code: "conflict",
    message: "Original identity conflicts.",
  })
  Object.setPrototypeOf(error, Error.prototype)
  const reply = backgroundReply(Exit.fail(error))
  const remote = backgroundRemote("a".repeat(64), () => ({
    invokeV1: async () => reply,
  }))
  const exit = await Effect.runPromiseExit(remote.read(19))
  expect(Exit.isFailure(exit) && exit.cause.reasons).toMatchObject([
    { _tag: "Fail", error: { code: "conflict" } },
  ])
})

it("projects undeclared runtime-initialization failures as defects", async () => {
  const reply = backgroundReply(
    Exit.fail({ _tag: "UsageStorageError", message: "private credential" })
  )
  expect(JSON.stringify(reply)).not.toContain("private credential")
  const remote = backgroundRemote("a".repeat(64), () => ({
    invokeV1: async () => reply,
  }))
  const exit = await Effect.runPromiseExit(remote.read(19))
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
})

it.each([
  { name: "malformed envelope", reply: { ok: false } },
  {
    name: "wrong operation result",
    reply: backgroundReply(Exit.succeed({ accepted: true })),
  },
  { name: "empty result", reply: backgroundReply(Exit.succeed(null)) },
])("treats $name as a protocol defect", async ({ reply }) => {
  const remote = backgroundRemote("a".repeat(64), () => ({
    invokeV1: async () => reply,
  }))
  const exit = await Effect.runPromiseExit(remote.read(19))
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
})

it("retains an actual transport outage as a safe expected failure", async () => {
  const remote = backgroundRemote("a".repeat(64), () => ({
    invokeV1: () => Promise.reject(new Error("private native outage")),
  }))
  const exit = await Effect.runPromiseExit(remote.read(19))
  expect(Exit.isFailure(exit) && exit.cause.reasons).toMatchObject([
    { _tag: "Fail", error: { _tag: "DelegationFailure", code: "unavailable" } },
  ])
  expect(JSON.stringify(exit)).not.toContain("private native outage")
})

it.each(["defect", "malformed"])(
  "joins a late %s reply after caller interruption",
  async (kind) => {
    let enter!: () => void, release!: (value: unknown) => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const reply = new Promise<unknown>((resolve) => {
      release = resolve
    })
    const controller = new AbortController()
    const remote = backgroundRemote("a".repeat(64), () => ({
      invokeV1: () => {
        enter()
        return reply
      },
    }))
    let settled = false
    const running = Effect.runPromiseExit(remote.read(19), {
      signal: controller.signal,
    }).then((exit) => {
      settled = true
      return exit
    })
    const result =
      kind === "defect"
        ? backgroundReply(Exit.die(new Error("private cleanup")))
        : { ok: false }
    try {
      await entered
      controller.abort()
      await Promise.resolve()
      expect(settled).toBe(false)
      release(result)
      const exit = await running
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
    } finally {
      release(result)
      await running
    }
  }
)
