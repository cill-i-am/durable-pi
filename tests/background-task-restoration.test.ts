import type { Context } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai"
import {
  Harness,
  ProviderDoc,
  createRegistry,
  defineDoc,
  type ConversationId,
  type StorageWrite,
} from "@earendil-works/pi-durable"
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory"
import { Effect, Exit } from "effect"
import { expect, it } from "vitest"

import {
  BackgroundDocument,
  piBackgroundLedger,
} from "../src/delegation/adapters/background-pi"
import {
  backgroundControlId,
  backgroundInitialId,
  migrateBackgroundState,
  restoreBackgroundState,
  type BackgroundState,
  type LegacyBackgroundState,
} from "../src/delegation/background-task-domain"
import {
  advanceBackgroundTask,
  initializeBackgroundTask,
} from "../src/delegation/background-task.machine"
import { makeBackgroundTasks } from "../src/delegation/background-tasks"
import { DelegationFailure } from "../src/delegation/contracts"
import { resolveRoute } from "../src/inference/policy"

const LegacyDocument = defineDoc({
  kind: "delegation.background",
  version: 1,
  scope: "session",
  initial: () => ({ value: "" }),
})
const steerId = "11111111-1111-4111-8111-111111111111"
const stopId = "22222222-2222-4222-8222-222222222222"
const handoff = () => ({
  id: 97,
  parentObject: "parent",
  turnId: "turn",
  conversationId: 1,
  reportId: "report",
  route: {
    ...resolveRoute("conversation", { model: "gpt-6-luna", thinking: "low" }),
    contextWindow: 8192,
  },
  memory: "Private reference; preserve its original deadline.",
  input: {
    objective: "Compare two private drafts",
    tasks: [
      { name: "Alpha", task: "Draft Alpha", tools: [] },
      { name: "Beta", task: "Draft Beta", tools: [] },
    ],
  },
  createdAt: 100,
  deadline: 10000,
})
const children = () => [
  { id: 3, provider: "provider-alpha" },
  { id: 5, provider: "provider-beta" },
]
const legacy = (): LegacyBackgroundState => ({
  handoff: handoff(),
  stopped: false,
  sealed: false,
  revision: 12,
  children: children().map((child, index) => ({
    ...child,
    requests: index === 0 ? 3 : 7,
    stopped: index === 1,
  })),
  controls: [
    {
      groupId: 97,
      childId: 3,
      operationId: steerId,
      action: { type: "steer", text: "Keep metric units" },
    },
    {
      groupId: 97,
      childId: 5,
      operationId: stopId,
      action: { type: "stop" },
    },
  ],
  applied: [steerId, stopId],
})
const restored = (state: BackgroundState) =>
  restoreBackgroundState(JSON.parse(JSON.stringify(state)))

/** Replay committed storage writes into a fresh backend; no tracker or actor survives. */
class RecordedMemoryStorage extends MemoryStorage {
  readonly commits: (readonly StorageWrite[])[] = []

  override async commit(writes: readonly StorageWrite[], callContext: Context) {
    const seq = await super.commit(writes, callContext)
    this.commits.push(structuredClone(writes))
    return seq
  }
}
const reopenStorage = async (previous: RecordedMemoryStorage) => {
  const storage = new RecordedMemoryStorage()
  for (const writes of previous.commits) await storage.commit(writes, context)
  return storage
}
const open = (storage: MemoryStorage) =>
  Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    context
  )
const ledger = (h: Harness) =>
  piBackgroundLedger(async () => h, {
    submit: async () => {
      throw new Error("Restoration must not submit native work")
    },
    abort: async () => {
      throw new Error("Restoration must not execute native cleanup")
    },
  })
const documentAddress = {
  scope: { kind: "session" as const },
  kind: "delegation.background",
}

it("cold reopens a v1 document, commits its migration, and preserves native identities and accepted work", async () => {
  let storage = new RecordedMemoryStorage()
  let h = await open(storage)
  try {
    const old = await h.commit(async (tx) => {
      const allocated: Array<LegacyBackgroundState["children"][number]> = []
      for (const task of handoff().input.tasks) {
        const child = await tx.createConversation({
          ownership: { kind: "ownerless" },
        })
        const provider = await tx.doc(ProviderDoc, child.id)
        allocated.push({
          id: Number(child.id),
          provider: provider.sessionId,
          requests: task.name === "Alpha" ? 3 : 7,
          stopped: task.name === "Beta",
        })
      }
      const value: LegacyBackgroundState = {
        ...legacy(),
        children: allocated,
        controls: legacy().controls.map((control, index) => ({
          ...control,
          childId: allocated[index]!.id,
        })),
      }
      ;(await tx.doc(LegacyDocument)).value = JSON.stringify(value)
      return value
    }, context)
    const originalDocument = await storage.findDocument(
      documentAddress,
      "current",
      context
    )
    expect(originalDocument).toBeDefined()
    expect(
      (await storage.document(originalDocument!.id, "current", context))
        ?.version
    ).toBe(1)
    const conversations = await storage.scanConversations(
      {},
      20,
      undefined,
      context
    )

    await h.close(context)
    storage = await reopenStorage(storage)
    h = await open(storage)
    const migrated = await Effect.runPromise(ledger(h).state())
    expect(migrated).toMatchObject({
      schemaVersion: 2,
      workflowVersion: 1,
      libraryVersion: "6.0.0-alpha.68/1.0.0-alpha.8",
      piVersion: "1.3.0",
      handoff: old.handoff,
      revision: old.revision,
      controls: old.controls,
      applied: old.applied,
      outcome: "working",
    })
    expect(
      migrated!.children.map(({ id, provider, requests }) => ({
        id,
        provider,
        requests,
      }))
    ).toEqual(
      old.children.map(({ id, provider, requests }) => ({
        id,
        provider,
        requests,
      }))
    )
    expect(migrated!.children[1]).toMatchObject({
      authority: "revoked",
      stop: "pending",
      stopAttempt: 0,
    })
    expect(migrated!.submissions.map(({ request }) => request)).toEqual([
      ...old.children.map((child) => backgroundInitialId(child.id)),
      backgroundControlId(old.controls[0]!),
    ])
    const saved = await storage.document(
      originalDocument!.id,
      "current",
      context
    )
    expect(saved?.version).toBe(2)
    expect(JSON.parse(String(saved?.value.value))).toEqual(migrated)
    expect(
      await storage.findDocument(documentAddress, "current", context)
    ).toEqual(originalDocument)
    expect(await storage.scanConversations({}, 20, undefined, context)).toEqual(
      conversations
    )
    expect((await h.inspect(context)).tasks).toEqual([])
    expect((await h.inspect(context)).submissions).toEqual([])

    await h.close(context)
    storage = await reopenStorage(storage)
    h = await open(storage)
    expect(await Effect.runPromise(ledger(h).state())).toEqual(migrated)
    await expect(h.snapshot(LegacyDocument, context)).rejects.toThrow(
      "has newer version 2 than 1"
    )
  } finally {
    await h.close(context)
  }
})

it("preserves an empty v1 document without manufacturing a group", async () => {
  let storage = new RecordedMemoryStorage()
  let h = await open(storage)
  try {
    await h.commit((tx) => tx.doc(LegacyDocument), context)
    await h.close(context)
    storage = await reopenStorage(storage)
    h = await open(storage)
    expect(await Effect.runPromise(ledger(h).state())).toBeUndefined()
    expect(await h.snapshot(BackgroundDocument, context)).toEqual({ value: "" })
    expect(
      (await storage.scanConversations({}, 20, undefined, context)).items
    ).toEqual([])
  } finally {
    await h.close(context)
  }
})

it.each([
  ["schemaVersion", 3],
  ["workflowVersion", 2],
  ["libraryVersion", "future-library"],
  ["piVersion", "future-native"],
])(
  "rejects an unknown %s without falling back to legacy restoration",
  (key, value) => {
    const current = migrateBackgroundState(legacy())
    const unknown = { ...current, [key]: value }
    expect(() => restoreBackgroundState(unknown)).toThrow()
    expect(() => migrateBackgroundState(unknown)).toThrow()
  }
)

it.each(["workflowVersion", "libraryVersion", "piVersion"])(
  "does not strip a stray %s from a purported legacy record",
  (key) => {
    expect(() =>
      migrateBackgroundState({ ...legacy(), [key]: "future" })
    ).toThrow()
  }
)

it.each([
  [
    "duplicate child identity",
    (state: BackgroundState) => ({
      ...state,
      children: [state.children[0]!, state.children[0]!],
    }),
  ],
  [
    "duplicate provider identity",
    (state: BackgroundState) => ({
      ...state,
      children: state.children.map((child) => ({
        ...child,
        provider: state.children[0]!.provider,
      })),
    }),
  ],
  [
    "foreign control group",
    (state: BackgroundState) => ({
      ...state,
      controls: state.controls.map((control) => ({ ...control, groupId: 999 })),
    }),
  ],
  [
    "foreign control child",
    (state: BackgroundState) => ({
      ...state,
      controls: state.controls.map((control) => ({ ...control, childId: 999 })),
    }),
  ],
  [
    "unknown applied operation",
    (state: BackgroundState) => ({
      ...state,
      applied: [...state.applied, "unknown"],
    }),
  ],
  [
    "duplicate native request",
    (state: BackgroundState) => ({
      ...state,
      submissions: [...state.submissions, state.submissions[0]!],
    }),
  ],
  [
    "changed native content",
    (state: BackgroundState) => ({
      ...state,
      submissions: state.submissions.map((command) => ({
        ...command,
        text: "Changed task",
      })),
    }),
  ],
  [
    "foreign native child",
    (state: BackgroundState) => ({
      ...state,
      submissions: state.submissions.map((command) => ({
        ...command,
        child: 999,
      })),
    }),
  ],
] as const)("rejects restored %s", (_name, corrupt) => {
  expect(() =>
    restoreBackgroundState(corrupt(migrateBackgroundState(legacy())))
  ).toThrow()
})

it.each([false, true])(
  "restores stopped legacy work with sealed=%s as cancelled and cleanup pending",
  (sealed) => {
    const state = restored(
      migrateBackgroundState({ ...legacy(), stopped: true, sealed })
    )
    expect(state.outcome).toBe("cancelled")
    expect(state.authority).toBe("revoked")
    expect(
      state.children.every(
        (child) => child.authority === "revoked" && child.stop === "pending"
      )
    ).toBe(true)
    expect(state.applied).toEqual(legacy().applied)
    const claimed = advanceBackgroundTask(state, {
      type: "CLAIM",
      request: state.submissions[0]!.request,
      now: 500,
      authorized: true,
    })
    expect(claimed).toBe(state)
  }
)

it("retains legacy completion while a later Stop has unresolved cleanup", () => {
  const old = {
    ...legacy(),
    sealed: true,
    controls: [],
    applied: [],
    children: legacy().children.map((child) => ({ ...child, stopped: false })),
  }
  const completed = restored(migrateBackgroundState(old))
  expect(completed.outcome).toBe("completed")
  const stopping = restored(
    advanceBackgroundTask(completed, { type: "REVOKE" })
  )
  expect(stopping.outcome).toBe("completed")
  expect(stopping.authority).toBe("revoked")
  expect(stopping.children.every((child) => child.stop === "pending")).toBe(
    true
  )
  expect(stopping.handoff.deadline).toBe(old.handoff.deadline)
  expect(stopping.children.map((child) => child.requests)).toEqual([3, 7])
})

it("fences stale native submission outcomes after restoring a renewed claim", () => {
  let state = initializeBackgroundTask(handoff(), children())
  const control = legacy().controls[0]!
  state = advanceBackgroundTask(state, {
    type: "CONTROL",
    input: control,
    now: 500,
  })
  const request = backgroundControlId(control)
  state = advanceBackgroundTask(state, {
    type: "CLAIM",
    request,
    now: 500,
    authorized: true,
  })
  const firstClaim = state.submissions.find(
    (command) => command.request === request
  )!.claim
  state = advanceBackgroundTask(state, {
    type: "UNCONFIRMED",
    request,
    claim: firstClaim,
  })
  state = restored(
    advanceBackgroundTask(state, {
      type: "CLAIM",
      request,
      now: 600,
      authorized: true,
    })
  )
  const currentClaim = state.submissions.find(
    (command) => command.request === request
  )!.claim
  expect(currentClaim).toBeGreaterThan(firstClaim)
  expect(
    advanceBackgroundTask(state, {
      type: "SUBMITTED",
      request,
      claim: firstClaim,
    })
  ).toBe(state)
  expect(
    advanceBackgroundTask(state, {
      type: "UNCONFIRMED",
      request,
      claim: firstClaim,
    })
  ).toBe(state)
  expect(state.applied).not.toContain(control.operationId)
  const acknowledged = advanceBackgroundTask(state, {
    type: "SUBMITTED",
    request,
    claim: currentClaim,
  })
  expect(
    acknowledged.submissions.find((command) => command.request === request)
      ?.status
  ).toBe("submitted")
  expect(acknowledged.applied).toEqual([control.operationId])
  expect(
    advanceBackgroundTask(acknowledged, {
      type: "SUBMITTED",
      request,
      claim: currentClaim,
    })
  ).toBe(acknowledged)
})

it.each(["STOP_ACK", "STOP_FAILED"] as const)(
  "does not accept %s before restored cleanup has been claimed",
  (type) => {
    const state = restored(
      migrateBackgroundState({ ...legacy(), stopped: true })
    )
    expect(
      advanceBackgroundTask(state, {
        type,
        child: state.children[0]!.id,
        attempt: 0,
      })
    ).toBe(state)
  }
)

it("fences stale Stop results across restoration and retains the completed outcome", () => {
  let state = advanceBackgroundTask(
    initializeBackgroundTask(handoff(), children()),
    {
      type: "OBSERVED",
      revision: 0,
      settled: true,
      now: 500,
    }
  )
  state = advanceBackgroundTask(state, { type: "REVOKE" })
  const child = state.children[0]!.id
  state = advanceBackgroundTask(state, { type: "STOP_CLAIM", child })
  const firstAttempt = state.children[0]!.stopAttempt
  state = advanceBackgroundTask(state, {
    type: "STOP_FAILED",
    child,
    attempt: firstAttempt,
  })
  state = restored(advanceBackgroundTask(state, { type: "STOP_CLAIM", child }))
  const currentAttempt = state.children[0]!.stopAttempt
  expect(currentAttempt).toBeGreaterThan(firstAttempt)
  expect(
    advanceBackgroundTask(state, {
      type: "STOP_ACK",
      child,
      attempt: firstAttempt,
    })
  ).toBe(state)
  expect(
    advanceBackgroundTask(state, {
      type: "STOP_FAILED",
      child,
      attempt: firstAttempt,
    })
  ).toBe(state)
  expect(state.children[0]!.stop).toBe("pending")
  const acknowledged = advanceBackgroundTask(state, {
    type: "STOP_ACK",
    child,
    attempt: currentAttempt,
  })
  expect(acknowledged.outcome).toBe("completed")
  expect(acknowledged.children[0]!.stop).toBe("confirmed")
  expect(acknowledged.children[1]!.stop).toBe("pending")
})

it.each([false, true])(
  "cold recovers a native receipt after lost acknowledgement with revoked=%s",
  async (revoked) => {
    let storage = new RecordedMemoryStorage()
    let h = await open(storage)
    const pin = handoff()
    pin.input.tasks = pin.input.tasks.slice(0, 1)
    const submitted: string[] = []
    const aborted: number[] = []
    const nativeLedger = (harness: Harness, loseAcknowledgement: boolean) =>
      piBackgroundLedger(async () => harness, {
        submit: async (child, text, requestId, steer) => {
          submitted.push(requestId)
          const conversation = await harness.conversation(
            child as ConversationId,
            context
          )
          const receipt = await conversation!.submit(
            {
              type: "input",
              content: text,
              requestId,
              whenBusy: steer ? "steer" : "followUp",
            },
            context
          )
          if (loseAcknowledgement)
            throw new DelegationFailure({
              code: "unavailable",
              message:
                "Native admission succeeded but its acknowledgement was lost",
            })
          return receipt
        },
        abort: async (child) => {
          const conversation = await harness.conversation(
            child as ConversationId,
            context
          )
          await conversation!.abort(context)
          aborted.push(child)
        },
      })
    const authority = { authorized: () => Effect.succeed(true) }
    try {
      const beforeLedger = nativeLedger(h, true)
      const beforeApp = makeBackgroundTasks(
        beforeLedger,
        authority,
        Effect.succeed(100)
      )
      await Effect.runPromise(beforeApp.initialize(pin))
      const child = (await Effect.runPromise(beforeLedger.state()))!
        .children[0]!
      for (let request = 0; request < 3; request++)
        await Effect.runPromise(beforeApp.request(child.provider))
      const failure = await Effect.runPromiseExit(beforeApp.advance())
      expect(Exit.isFailure(failure)).toBe(true)
      if (Exit.isSuccess(failure))
        throw new Error("Expected lost acknowledgement")
      expect(
        failure.cause.reasons.some(
          (reason) =>
            reason._tag === "Fail" && reason.error.code === "unavailable"
        )
      ).toBe(true)
      const requestId = backgroundInitialId(child.id)
      const before = (await Effect.runPromise(beforeLedger.state()))!
      expect(before.submissions[0]).toMatchObject({
        child: child.id,
        request: requestId,
        status: "unconfirmed",
      })
      expect(before.submissions[0]!.claim).toBeGreaterThan(0)
      expect(before.children[0]!.requests).toBe(3)
      const receipt = await h.commit(
        (tx) => tx.submissionByRequest(child.id as ConversationId, requestId),
        context
      )
      expect(receipt).toMatchObject({
        requestId,
        conversationId: child.id,
        type: "input",
      })
      // Native no-model settlement is deterministic and does not invoke a provider.
      await h.waitForIdle(context)
      if (revoked)
        await Effect.runPromise(
          beforeLedger.atomic((tx) =>
            Effect.gen(function* () {
              const document = yield* tx.state()
              document.value = advanceBackgroundTask(document.value!, {
                type: "REVOKE",
              })
            })
          )
        )
      const saved = (await Effect.runPromise(beforeLedger.state()))!
      expect(saved.children[0]!.stop).toBe(revoked ? "pending" : "none")
      const conversations = await storage.scanConversations(
        {},
        20,
        undefined,
        context
      )

      await h.close(context)
      storage = await reopenStorage(storage)
      h = await open(storage)
      const afterLedger = nativeLedger(h, false)
      const afterApp = makeBackgroundTasks(
        afterLedger,
        authority,
        Effect.succeed(100)
      )
      expect(await Effect.runPromise(afterLedger.state())).toEqual(saved)
      await Effect.runPromise(afterApp.initialize(pin))
      const submittedBeforeRecovery = submitted.length
      await Effect.runPromise(afterApp.advance())
      const after = (await Effect.runPromise(afterLedger.state()))!
      const recoveredReceipt = await h.commit(
        (tx) => tx.submissionByRequest(child.id as ConversationId, requestId),
        context
      )
      expect(recoveredReceipt?.id).toBe(receipt!.id)
      expect(recoveredReceipt?.requestId).toBe(requestId)
      expect(after.handoff).toEqual(pin)
      expect(after.children[0]).toMatchObject({
        id: child.id,
        provider: child.provider,
        requests: 3,
      })
      expect(after.submissions[0]).toMatchObject({
        child: child.id,
        request: requestId,
        text: pin.input.tasks[0]!.task,
        steer: false,
        status: revoked ? "unconfirmed" : "submitted",
      })
      expect(
        await storage.scanConversations({}, 20, undefined, context)
      ).toEqual(conversations)
      expect(
        (await storage.scanSubmissions({}, 20, undefined, context)).items
      ).toHaveLength(1)
      if (revoked) {
        expect(submitted).toHaveLength(submittedBeforeRecovery)
        expect(aborted).toEqual([child.id])
        expect(after.outcome).toBe("cancelled")
        expect(after.children[0]!.stop).toBe("confirmed")
        expect((await h.inspect(context)).tasks).toEqual([])
      } else {
        expect(submitted).toEqual([requestId, requestId])
        expect(aborted).toEqual([])
      }
    } finally {
      await h.close(context)
    }
  }
)
