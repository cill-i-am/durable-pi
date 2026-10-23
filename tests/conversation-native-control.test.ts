import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  BACKGROUND_CONTEXT,
  type Context as PiContext,
} from "@earendil-works/chord/context"
import {
  Type,
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai"
import {
  Harness,
  createRegistry,
  defineTool,
  type SubmissionRecord,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import type { PiHarness } from "agents/harness/pi"
import { Cause, Context, Effect, Exit } from "effect"
import { expect, it, vi } from "vitest"

import {
  piConversationLayer,
  normalizePiObservation,
} from "../src/conversations/adapters/pi-execution"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { ConversationExecution } from "../src/conversations/execution"
import { database } from "./database"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const executionFor = (harness: PiHarness) =>
  Effect.runPromise(
    ConversationExecution.pipe(
      Effect.provide(
        piConversationLayer(
          () => harness,
          () => "faux-1"
        )
      )
    )
  )

function turn() {
  const store = new ConversationStore(database(), {
    model: "faux-1",
    thinking: "off",
  })
  return Effect.runSync(
    store.admit(
      { operationId: "root", text: "hello" },
      undefined,
      [],
      undefined,
      { discoveryDeadline: Date.now() + 60_000 }
    )
  ).turn
}

it("distinguishes a queued native receipt from absent submission without calling submit", () => {
  const root = turn()
  const snapshot = {
    type: "snapshot" as const,
    nestedTools: [],
    entries: [],
    tools: [],
    inbox: [],
    compactions: [],
    agent: {},
    usage: { models: {}, tools: {} },
  }
  const queued = {
    id: 1,
    conversationId: 1,
    type: "input",
    status: "queued",
    requestId: root.id,
  } as SubmissionRecord
  const known = normalizePiObservation(root, [root], {
    snapshot,
    records: new Map([[root.id, queued]]),
  })
  expect(known.accepted).toEqual([root.id])
  expect(known.settled).toBe(false)
  expect(known.consumed).toEqual([])
  expect(
    normalizePiObservation(root, [root], {
      snapshot,
      records: new Map(),
    }).accepted
  ).toEqual([])
})

it("joins a late native conversation lookup and skips abort after owner cancellation", async () => {
  const entered = deferred(),
    release = deferred()
  const abort = vi.fn(async () => {})
  const legacyAbort = vi.fn(async () => {})
  const execution = await executionFor({
    conversation: async () => {
      entered.resolve()
      await release.promise
      return { abort }
    },
    session: () => ({ abort: legacyAbort }),
  } as unknown as PiHarness)
  const controller = new AbortController()
  let ended = false
  const pending = Effect.runPromiseExit(execution.abort("session"), {
    signal: controller.signal,
  }).then((exit) => {
    ended = true
    return exit
  })
  await entered.promise
  controller.abort()
  expect(ended).toBe(false)
  release.resolve()
  const exit = await pending
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(abort).not.toHaveBeenCalled()
  expect(legacyAbort).not.toHaveBeenCalled()
})

it("passes configuration cancellation to native Pi and joins its settlement", async () => {
  const entered = deferred(),
    cancelled = deferred(),
    release = deferred()
  const execution = await executionFor({
    conversation: async () => ({
      configure: async (_change: unknown, context: PiContext) => {
        context.abortSignal!.addEventListener("abort", cancelled.resolve, {
          once: true,
        })
        entered.resolve()
        await release.promise
        context.abortSignal!.throwIfAborted()
      },
    }),
  } as unknown as PiHarness)
  const controller = new AbortController()
  let ended = false
  const pending = Effect.runPromiseExit(
    execution.configure("session", turn()),
    { signal: controller.signal }
  ).then((exit) => {
    ended = true
    return exit
  })
  await entered.promise
  controller.abort()
  await cancelled.promise
  expect(ended).toBe(false)
  release.resolve()
  const exit = await pending
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
})

it.each(["submit", "steer"] as const)(
  "joins native %s with its stable receipt identity after cancellation",
  async (operation) => {
    const entered = deferred(),
      release = deferred()
    const native = vi.fn(async () => {
      entered.resolve()
      await release.promise
      return { operationId: "root", session: "session", accepted: true }
    })
    const execution = await executionFor({
      submit: native,
      session: () => ({ steer: native }),
    } as unknown as PiHarness)
    const controller = new AbortController()
    let ended = false
    const pending = Effect.runPromiseExit(
      execution[operation]("session", { ...turn(), prompt: "hello" }),
      { signal: controller.signal }
    ).then((exit) => {
      ended = true
      return exit
    })
    await entered.promise
    controller.abort()
    expect(ended).toBe(false)
    expect(native).toHaveBeenCalledExactlyOnceWith(
      operation === "submit"
        ? "hello"
        : [
            {
              type: "text",
              text: JSON.stringify({
                provenance: { author: { kind: "unknown" } },
                content: "hello",
              }),
            },
          ],
      operation === "submit"
        ? { session: "session", operationId: "root" }
        : { operationId: "root" }
    )
    release.resolve()
    const exit = await pending
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  }
)

const NativeMarker = Context.Service<string>("test/native-control/marker")

it.each(["rejection", "failure", "interrupted", "compound"] as const)(
  "retains a late native abort %s and annotations after joined cancellation",
  async (kind) => {
    const entered = deferred(),
      release = deferred()
    const rejected = new Error("abort settlement rejected"),
      defect = new Error("abort cleanup defect")
    const execution = await executionFor({
      conversation: async () => ({
        abort: async () => {
          entered.resolve()
          await release.promise
          if (kind === "rejection") throw rejected
          throw Cause.fromReasons([
            Cause.makeFailReason(rejected).annotate(
              Context.make(NativeMarker, "original")
            ),
            ...(kind === "compound" ? [Cause.makeDieReason(defect)] : []),
            ...(kind === "failure" ? [] : [Cause.makeInterruptReason()]),
          ])
        },
      }),
    } as unknown as PiHarness)
    const controller = new AbortController()
    let ended = false
    const pending = Effect.runPromiseExit(execution.abort("session"), {
      signal: controller.signal,
    }).then((exit) => {
      ended = true
      return exit
    })
    await entered.promise
    controller.abort()
    expect(ended).toBe(false)
    release.resolve()
    const exit = await pending
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(
        exit.cause.reasons.filter(
          (reason) => reason._tag === "Die" && reason.defect === defect
        )
      ).toHaveLength(kind === "compound" ? 1 : 0)
      const failures = exit.cause.reasons.filter(
        (reason) =>
          reason._tag === "Die" &&
          Cause.isReason(reason.defect) &&
          Cause.isFailReason(reason.defect)
      )
      expect(failures).toHaveLength(1)
      expect(failures).toEqual([
        expect.objectContaining({
          _tag: "Die",
          defect: expect.objectContaining({
            _tag: "Fail",
            error: expect.objectContaining({
              _tag: "ConversationExecutionError",
              operation: "abort",
              cause: rejected,
            }),
          }),
        }),
      ])
      const failure = failures[0]
      if (
        kind !== "rejection" &&
        failure?._tag === "Die" &&
        Cause.isReason(failure.defect) &&
        Cause.isFailReason(failure.defect)
      )
        expect(failure.defect.annotations.get(NativeMarker.key)).toBe(
          "original"
        )
    }
  }
)

it("interrupts a native abort wait without confirming task cleanup or aborting later input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-native-control-"))
  const entered = deferred(),
    cancelled = deferred(),
    release = deferred()
  let toolSettled = false
  const faux = fauxProvider({ tokensPerSecond: 100000 })
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hold", {}, { id: "held-tool" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Continuation completed"),
  ])
  const models = createModels()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  registry.install({
    name: "native-control",
    tools: [
      defineTool({
        name: "hold",
        description: "Hold a synthetic tool until cleanup is released",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async (_args, _api, context) => {
          context.abortSignal!.addEventListener("abort", cancelled.resolve, {
            once: true,
          })
          entered.resolve()
          await release.promise
          toolSettled = true
          return { output: [{ type: "text", text: "Released" }] }
        },
      }),
    ],
  })
  const storage = await openNodeSqliteStorage(join(directory, "pi.sqlite"))
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      settings: { compaction: { enabled: false }, retry: { enabled: false } },
    },
    BACKGROUND_CONTEXT
  )
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    })
    await conversation.submit(
      {
        type: "input",
        requestId: "original",
        content: [{ type: "text", text: "Hold" }],
      },
      BACKGROUND_CONTEXT
    )
    await entered.promise
    const execution = await executionFor({
      conversation: async () => conversation,
    } as unknown as PiHarness)
    const controller = new AbortController()
    let ended = false
    const pending = Effect.runPromiseExit(
      execution.abort(String(conversation.id)),
      { signal: controller.signal }
    ).then((exit) => {
      ended = true
      return exit
    })
    await cancelled.promise
    expect(toolSettled).toBe(false)
    expect(ended).toBe(false)
    controller.abort()
    await expect.poll(() => ended).toBe(true)
    const exit = await pending
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(toolSettled).toBe(false)
    expect(
      (await harness.inspect(BACKGROUND_CONTEXT)).tasks.length
    ).toBeGreaterThan(0)
    release.resolve()
    await conversation.waitForIdle(BACKGROUND_CONTEXT)
    expect(toolSettled).toBe(true)
    const continuation = await conversation.submit(
      {
        type: "input",
        requestId: "continuation",
        content: [{ type: "text", text: "Continue after cleanup" }],
      },
      BACKGROUND_CONTEXT
    )
    await continuation.wait(BACKGROUND_CONTEXT)
    await conversation.waitForIdle(BACKGROUND_CONTEXT)
    expect(toolSettled).toBe(true)
    expect((await harness.inspect(BACKGROUND_CONTEXT)).tasks).toHaveLength(0)
    expect(
      await storage.submissionByRequest(
        conversation.id,
        "continuation",
        BACKGROUND_CONTEXT
      )
    ).toMatchObject({ status: "done" })
    expect(faux.state.callCount).toBe(2)
  } finally {
    release.resolve()
    await harness.close(BACKGROUND_CONTEXT)
    await rm(directory, { recursive: true, force: true })
  }
}, 15000)
