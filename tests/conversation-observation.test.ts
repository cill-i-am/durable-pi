import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import type {
  EntryRecord,
  SnapshotEvent,
  SubmissionRecord,
} from "@earendil-works/pi-durable"
import type { PiHarness } from "agents/harness/pi"
import { Cause, Effect, Exit, Logger } from "effect"
import { expect, it, vi } from "vitest"

import {
  normalizePiObservation,
  piConversationObserver,
  piConversationLayer,
  conversationNativeOperation,
} from "../src/conversations/adapters/pi-execution"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import type { TurnOrigin } from "../src/conversations/contracts"
import { ConversationExecution } from "../src/conversations/execution"
import { database } from "./database"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it("clears inherited tool exclusions for web, channel messages and agent reports", async () => {
  const f = fixture()
  const configure = vi.fn(async (_change: unknown) => {})
  const harness = {
    conversation: async () => ({ configure }),
  } as unknown as PiHarness
  const execution = await Effect.runPromise(
    ConversationExecution.pipe(
      Effect.provide(
        piConversationLayer(
          () => harness,
          () => "default"
        )
      )
    )
  )
  const origins: (TurnOrigin | undefined)[] = [
    undefined,
    { kind: "whatsapp", sender: "owner", messageId: "message" },
    { kind: "email", sender: "owner", subject: "question" },
    { kind: "background", groupId: 1, turnId: "worker" },
    { kind: "communication", taskId: "report", turnId: "sender" },
  ]
  for (const origin of origins) {
    await Effect.runPromise(
      execution.configure("session", { ...f.root, origin })
    )
    expect(configure.mock.lastCall?.[0]).toMatchObject({ tools: null })
  }
})

it("keeps corrupt historical prompt arrays as defects before native submission", async () => {
  const f = fixture()
  const submit = vi.fn(async () => {})
  const harness = { submit } as unknown as PiHarness
  const execution = await Effect.runPromise(
    ConversationExecution.pipe(
      Effect.provide(
        piConversationLayer(
          () => harness,
          () => "default"
        )
      )
    )
  )
  const exit = await Effect.runPromiseExit(
    execution.submit("session", { ...f.root, prompt: "[invalid JSON" })
  )
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
  expect(submit).not.toHaveBeenCalled()
})

it("joins a late native conversation lookup after cancellation and skips configuration", async () => {
  const f = fixture(),
    started = deferred(),
    settled = deferred()
  const configure = vi.fn(async () => {})
  const harness = {
    conversation: async () => {
      started.resolve()
      await settled.promise
      return { configure }
    },
  } as unknown as PiHarness
  const execution = await Effect.runPromise(
    ConversationExecution.pipe(
      Effect.provide(
        piConversationLayer(
          () => harness,
          () => "default"
        )
      )
    )
  )
  const controller = new AbortController()
  let ended = false
  const pending = Effect.runPromiseExit(
    execution.configure("session", f.root),
    { signal: controller.signal }
  ).then((exit) => {
    ended = true
    return exit
  })
  await started.promise
  controller.abort()
  expect(ended).toBe(false)
  settled.resolve()
  const exit = await pending
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(configure).not.toHaveBeenCalled()
})

const entry = (id: number): EntryRecord => ({
  id: id as EntryRecord["id"],
  conversationId: 0 as EntryRecord["conversationId"],
  kind: "pi.user",
})
const snapshot = (ids: number[]): SnapshotEvent => ({
  type: "snapshot",
  nestedTools: [],
  entries: ids.map(entry),
  tools: [],
  inbox: [],
  compactions: [],
  agent: {},
  usage: { models: {}, tools: {} },
})
const done = {
  id: 1,
  conversationId: 0,
  type: "input",
  status: "done",
  entry: 1,
  answer: 2,
} as SubmissionRecord
it("archives only the new continuation when a native session is reused", () => {
  const f = fixture()
  const root = {
    ...f.root,
    origin: {
      kind: "coordination" as const,
      turnId: "original",
      messageId: "peer-message",
    },
  }
  const entries: EntryRecord[] = [
    { ...entry(1), model: [fauxAssistantMessage("Old response")] },
    {
      ...entry(3),
      model: [{ role: "user", content: "Peer question", timestamp: 3 }],
    },
    { ...entry(4), model: [fauxAssistantMessage("New response")] },
  ]
  const observation = normalizePiObservation(root, [root], {
    snapshot: { ...snapshot([]), entries },
    records: new Map([
      [root.id, { ...done, entry: 3, answer: 4 } as SubmissionRecord],
    ]),
  })
  expect(observation.answer).toBe("New response")
  expect(observation.archives.map((record) => record.text)).not.toContain(
    "Old response"
  )
})
function fixture() {
  const store = new ConversationStore(database(), {
    model: "test",
    thinking: "off",
  })
  const admit = store.admit.bind(store)
  store.admit = (input, prepared, skills, resolved, options) =>
    admit(
      input,
      prepared,
      skills,
      resolved,
      options ?? { discoveryDeadline: Date.now() + 60_000 }
    )
  Effect.runSync(store.admit({ operationId: "root", text: "hello" }))
  Effect.runSync(store.saveSession("root", "session"))
  const root = Effect.runSync(store.get("root"))!
  const reads = vi.fn(async () => done)
  const stop = vi.fn(async () => {})
  const events = vi.fn(async () => ({ snapshot: snapshot([1, 2]), stop }))
  const entries = vi.fn(async () => ({ items: [] as EntryRecord[] }))
  const harness = {
    storage: async () => ({ submissionByRequest: reads }),
    conversation: async () => ({ id: 0, entries }),
    session: () => ({ events }),
  } as unknown as PiHarness
  return {
    root,
    store,
    reads,
    stop,
    events,
    entries,
    execution: piConversationObserver(() => harness),
  }
}

it("normalizes historical archive identities, steering, consumed inputs and live text", () => {
  const { root, store } = fixture()
  const child = Effect.runSync(
    store.admit({
      operationId: "child",
      text: "use blue",
      mode: "steer",
    })
  ).turn
  const user = {
    ...entry(1),
    model: [{ role: "user" as const, content: "hello", timestamp: 1 }],
  }
  const response = { ...entry(2), model: [fauxAssistantMessage("Answer")] }
  const steer = {
    ...entry(3),
    model: [{ role: "user" as const, content: "use blue", timestamp: 2 }],
  }
  const observation = normalizePiObservation(root, [root, child], {
    snapshot: {
      ...snapshot([]),
      entries: [user, response, steer],
      generation: {
        message: fauxAssistantMessage("partial"),
      } as SnapshotEvent["generation"],
    },
    records: new Map([
      [root.id, done],
      [
        child.id,
        {
          ...done,
          entry: entry(3).id,
          answer: entry(4).id,
        } as SubmissionRecord,
      ],
    ]),
  })
  expect(observation.answer).toBe("Answer")
  expect(observation.liveAnswer).toBe("Answerpartial")
  expect(observation.settled).toBe(false)
  expect(observation.consumed).toEqual([root.id, child.id])
  expect(observation.outcomes).toEqual([
    { id: root.id, delivery: "answered" },
    { id: child.id, delivery: "answered" },
  ])
  expect(observation.archives.map(({ source }) => source)).toEqual([
    "user:root",
    "root:2:0:talk",
    "user:child",
  ])
  expect(observation.archivedActivity).toContainEqual({
    id: "steer:child",
    type: "steer",
    text: "use blue",
    created_at: child.created_at,
    attachments: [],
  })
  expect(
    observation.archivedActivity.some(
      (item) => "text" in item && item.text === "partial"
    )
  ).toBe(false)
  expect(
    observation.activity.some(
      (item) => "text" in item && item.text === "partial"
    )
  ).toBe(true)
})

it("closes the snapshot stream before reading receipts", async () => {
  const f = fixture()
  f.reads.mockImplementation(async () => {
    expect(f.stop).toHaveBeenCalledOnce()
    return done
  })
  const observation = await Effect.runPromise(
    f.execution.observe(f.root, [f.root])
  )
  expect(observation.settled).toBe(true)
  expect(observation.consumed).toEqual([f.root.id])
  expect(f.stop).toHaveBeenCalledOnce()
})

it("joins a late snapshot acquisition and stop after interruption without reading receipts", async () => {
  const f = fixture(),
    started = deferred(),
    acquired = deferred(),
    stopping = deferred(),
    released = deferred()
  f.events.mockImplementation(async () => {
    started.resolve()
    await acquired.promise
    return { snapshot: snapshot([1, 2]), stop: f.stop }
  })
  f.stop.mockImplementation(async () => {
    stopping.resolve()
    await released.promise
  })
  const controller = new AbortController()
  let ended = false
  const pending = Effect.runPromiseExit(f.execution.observe(f.root, [f.root]), {
    signal: controller.signal,
  }).then((exit) => {
    ended = true
    return exit
  })
  await started.promise
  controller.abort()
  expect(ended).toBe(false)
  acquired.resolve()
  await stopping.promise
  expect(ended).toBe(false)
  expect(f.reads).not.toHaveBeenCalled()
  released.resolve()
  const exit = await pending
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(f.stop).toHaveBeenCalledOnce()
  expect(f.reads).not.toHaveBeenCalled()
})

it("joins an in-flight transcript page and skips subsequent pages after cancellation", async () => {
  const f = fixture(),
    started = deferred(),
    released = deferred()
  f.events.mockResolvedValue({
    snapshot: {
      ...snapshot([]),
      entries: [{ ...entry(3), head: entry(1).id }],
    },
    stop: f.stop,
  })
  // The native read ignores cancellation, so the adapter retains ownership.
  const harness = {
    storage: async () => ({ submissionByRequest: f.reads }),
    conversation: async () => ({
      id: 0,
      entries: vi.fn(async () => {
        started.resolve()
        await released.promise
        return { items: [entry(1)], next: { offset: 1 } }
      }),
    }),
    session: () => ({ events: f.events }),
  }
  const conversation = await harness.conversation()
  const stableHarness = {
    ...harness,
    conversation: async () => conversation,
  } as unknown as PiHarness
  const execution = piConversationObserver(() => stableHarness)
  const controller = new AbortController()
  let ended = false
  const pending = Effect.runPromiseExit(execution.observe(f.root, [f.root]), {
    signal: controller.signal,
  }).then((exit) => {
    ended = true
    return exit
  })
  await started.promise
  controller.abort()
  expect(ended).toBe(false)
  released.resolve()
  const exit = await pending
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(conversation.entries).toHaveBeenCalledOnce()
})

it("reports a stream close failure that arrives after interruption", async () => {
  const f = fixture(),
    started = deferred(),
    released = deferred()
  const logs: string[] = []
  f.stop.mockImplementation(async () => {
    started.resolve()
    await released.promise
    throw new Error("native close failed")
  })
  const controller = new AbortController()
  const pending = Effect.runPromiseExit(
    f.execution.observe(f.root, [f.root]).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make((options) => {
            logs.push(String(options.message))
          }),
        ])
      )
    ),
    { signal: controller.signal }
  )
  await started.promise
  controller.abort()
  released.resolve()
  const exit = await pending
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(logs).toEqual(["Conversation.nativeOperationFailedAfterCancellation"])
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(f.stop).toHaveBeenCalledOnce()
  expect(f.reads).not.toHaveBeenCalled()
})

it.each(["capture", "receipt"])(
  "reports typed native %s failures and releases an acquired stream",
  async (operation) => {
    const f = fixture(),
      cause = new Error("native unavailable")
    if (operation === "capture") f.events.mockRejectedValue(cause)
    if (operation === "receipt") f.reads.mockRejectedValue(cause)
    const result = await Effect.runPromise(
      f.execution.observe(f.root, [f.root]).pipe(Effect.result)
    )
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ConversationExecutionError",
        cause,
        operation:
          operation === "receipt" ? "read submission" : "capture snapshot",
      },
    })
    expect(f.stop).toHaveBeenCalledTimes(operation === "capture" ? 0 : 1)
    if (operation !== "receipt") expect(f.reads).not.toHaveBeenCalled()
  }
)

it("keeps a native observer stop failure a defect and joins its release", async () => {
  const f = fixture(),
    defect = new Error("native stop failed")
  f.stop.mockRejectedValue(defect)
  const exit = await Effect.runPromiseExit(
    f.execution.observe(f.root, [f.root])
  )
  expect(
    Exit.isFailure(exit) &&
      exit.cause.reasons.some(
        (reason) => reason._tag === "Die" && reason.defect === defect
      )
  ).toBe(true)
  expect(f.reads).not.toHaveBeenCalled()
  expect(f.stop).toHaveBeenCalledOnce()
})

it("retains a native compound Cause instead of flattening a defect or interruption into observation unavailability", async () => {
  const defect = new Error("native invariant"),
    interrupt = Cause.makeInterruptReason(32)
  const exit = await Effect.runPromiseExit(
    conversationNativeOperation("probe", () =>
      Promise.reject(
        Cause.fromReasons([
          Cause.makeFailReason(new Error("transport")),
          Cause.makeDieReason(defect),
          interrupt,
        ])
      )
    )
  )
  expect(
    Exit.isFailure(exit) &&
      exit.cause.reasons.some(
        (reason) => reason._tag === "Die" && reason.defect === defect
      )
  ).toBe(true)
  expect(Exit.isFailure(exit) && exit.cause.reasons.includes(interrupt)).toBe(
    true
  )
})

it("retains both snapshot acquisition and native observer cleanup defects", async () => {
  const f = fixture(),
    snapshotFailure = new Error("snapshot invariant"),
    cleanup = new Error("observer stop invariant")
  f.events.mockImplementation(async () => ({
    get snapshot(): SnapshotEvent {
      throw snapshotFailure
    },
    stop: f.stop,
  }))
  f.stop.mockRejectedValue(cleanup)
  const exit = await Effect.runPromiseExit(
    f.execution.observe(f.root, [f.root])
  )
  for (const defect of [snapshotFailure, cleanup])
    expect(
      Exit.isFailure(exit) &&
        exit.cause.reasons.some(
          (reason) => reason._tag === "Die" && reason.defect === defect
        )
    ).toBe(true)
  expect(f.reads).not.toHaveBeenCalled()
})

it("joins a late native Cause and retains its defect after caller interruption", async () => {
  const entered = deferred(),
    release = deferred(),
    controller = new AbortController(),
    defect = new Error("late native invariant")
  let ended = false
  const pending = Effect.runPromiseExit(
    conversationNativeOperation("held native", async () => {
      entered.resolve()
      await release.promise
      throw Cause.die(defect)
    }).pipe(Effect.provide(Logger.layer([]))),
    { signal: controller.signal }
  ).then((exit) => {
    ended = true
    return exit
  })
  await entered.promise
  controller.abort()
  expect(ended).toBe(false)
  release.resolve()
  const exit = await pending
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(
    Exit.isFailure(exit) &&
      exit.cause.reasons.some(
        (reason) => reason._tag === "Die" && reason.defect === defect
      )
  ).toBe(true)
})
