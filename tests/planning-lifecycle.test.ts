import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai"
import {
  Harness,
  createRegistry,
  defineDoc,
  defineDocFamily,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { Cause, Effect, Exit } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import { plansRequest } from "../src/planning/adapters/http"
import {
  piPlans,
  planBlockerStatus,
  planDigest,
} from "../src/planning/adapters/pi"
import {
  advancePlanBinding,
  advancePlanOperation,
} from "../src/planning/authority.machine"
import {
  PlanFailure,
  type Plan,
  type PlanReceipt,
  type PlanUpdate,
} from "../src/planning/contracts"
import { revisePlan } from "../src/planning/plan.machine"
import type {
  PlanAuthority,
  PlanEvidence,
  PlanSource,
} from "../src/planning/plans"

const LegacyCatalog = defineDoc({
  checkpointWhen: () => false,
  kind: "plans.catalog",
  scope: "session",
  version: 1,
  initial: () => ({ ids: [] as string[] }),
})
const LegacyPlan = defineDocFamily({
  checkpointWhen: () => false,
  kind: "plans.task",
  scope: "session",
  family: true,
  version: 1,
  initial: (_: null) => ({ value: "" }),
})
const History = defineDocFamily({
  checkpointWhen: () => false,
  kind: "plans.revision",
  scope: "session",
  family: true,
  version: 1,
  initial: (_: null) => ({ value: "" }),
})
const LegacyBinding = defineDocFamily({
  checkpointWhen: () => false,
  kind: "plans.turn",
  scope: "session",
  family: true,
  version: 1,
  initial: (_: null) => ({ planId: "", cancelled: false }),
})
const LegacyOperation = defineDocFamily({
  checkpointWhen: () => false,
  kind: "plans.operation",
  scope: "session",
  family: true,
  version: 1,
  initial: (_: null) => ({ digest: "", receipt: "" }),
})

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})
const valid: PlanEvidence = (ref) =>
  Effect.succeed({ ...ref, state: "valid", detail: "Saved source" })
const source = (): PlanSource => {
  const turnId = crypto.randomUUID()
  return { turnId, inputRevision: 0, inputIds: [turnId] }
}
const update = (origin: PlanSource): PlanUpdate => ({
  id: crypto.randomUUID(),
  operationId: "tool:1",
  relation: "new",
  expectedRevision: 0,
  inputRevision: origin.inputRevision,
  reason: "Saved the artifact",
  draft: {
    objective: "Prepare a private artifact",
    constraints: ["Do not publish"],
    criteria: ["Artifact saved"],
    steps: [
      {
        id: "save",
        title: "Save artifact",
        status: "completed",
        evidence: [{ kind: "file", id: crypto.randomUUID(), revision: 0 }],
        note: "",
      },
    ],
    nextAction: "",
    blocker: "",
    complete: true,
  },
})
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function nativePi() {
  const directory = await mkdtemp(join(tmpdir(), "planning-lifecycle-")),
    path = join(directory, "pi.sqlite"),
    options = { models: createModels(), registry: createRegistry() }
  let storage = await openNodeSqliteStorage(path),
    harness = await Harness.open(storage, options, ctx)
  const state = { source: source(), evidence: valid }
  const authority: PlanAuthority = {
    current: () => Effect.sync(() => state.source),
    cancelled: () => Effect.succeed(false),
    receipts: () => Effect.succeed([]),
    evidence: (ref, roots) => state.evidence(ref, roots),
  }
  const plans = piPlans(async () => harness, authority)
  cleanups.push(async () => {
    await harness.close(ctx)
    await rm(directory, { recursive: true, force: true })
  })
  return {
    path,
    state,
    plans,
    get harness() {
      return harness
    },
    get storage() {
      return storage
    },
    restart: async () => {
      await harness.close(ctx)
      storage = await openNodeSqliteStorage(path)
      harness = await Harness.open(storage, options, ctx)
    },
    stored: async (kind: string, key?: string) => {
      const record = await storage.findDocument(
        { kind, scope: { kind: "session" }, ...(key ? { key } : {}) },
        "current",
        ctx
      )
      return record ? storage.document(record.id, "current", ctx) : undefined
    },
  }
}

async function seedLegacy(f: Awaited<ReturnType<typeof nativePi>>) {
  const input = update(f.state.source),
    now = "2026-10-23T00:00:00.000Z"
  const plan: Plan = {
    ...input.draft,
    steps: input.draft.steps.map((step) => ({
      ...step,
      evidence: step.evidence.map((ref) => ({
        ...ref,
        state: "valid",
        detail: "Saved source",
      })),
    })),
    id: input.id,
    schemaVersion: 1,
    revision: 1,
    state: "completed",
    rootTurns: [f.state.source.turnId],
    inputIds: f.state.source.inputIds,
    reviewedTurn: f.state.source.turnId,
    inputRevision: f.state.source.inputRevision,
    createdAt: now,
    updatedAt: now,
  }
  const receipt: PlanReceipt = {
    id: input.id,
    revision: 1,
    state: "completed",
    reopened: [],
  }
  const digest = await Effect.runPromise(
    planDigest({ input, source: f.state.source })
  )
  const document = JSON.stringify(plan, null, 2),
    receiptText = JSON.stringify(receipt, null, 2),
    history = JSON.stringify({
      plan,
      actor: "agent",
      reason: input.reason,
      turnId: f.state.source.turnId,
    })
  await f.harness.commit(async (tx) => {
    ;(await tx.doc(LegacyCatalog)).ids.push(input.id)
    ;(await tx.doc(LegacyPlan, input.id, null)).value = document
    ;(await tx.doc(History, `${input.id}:1`, null)).value = history
    Object.assign(await tx.doc(LegacyBinding, f.state.source.turnId, null), {
      planId: input.id,
      cancelled: false,
    })
    Object.assign(await tx.doc(LegacyOperation, input.operationId, null), {
      digest,
      receipt: receiptText,
    })
  }, ctx)
  return { input, plan, receipt, document, receiptText, history, digest }
}

it("upgrades legacy native plan, binding and operation controls without rewriting receipt or history payloads", async () => {
  const f = await nativePi(),
    legacy = await seedLegacy(f)
  const before = await Promise.all([
    f.stored("plans.task", legacy.input.id),
    f.stored("plans.turn", f.state.source.turnId),
    f.stored("plans.operation", legacy.input.operationId),
  ])
  expect(before.map((doc) => doc?.version)).toEqual([1, 1, 1])
  await f.restart()
  expect((await Effect.runPromise(f.plans.read(legacy.input.id))).plan).toEqual(
    legacy.plan
  )
  expect(
    await Effect.runPromise(f.plans.update(legacy.input, f.state.source))
  ).toEqual(legacy.receipt)
  const after = await Promise.all([
    f.stored("plans.task", legacy.input.id),
    f.stored("plans.turn", f.state.source.turnId),
    f.stored("plans.operation", legacy.input.operationId),
  ])
  expect(after.map((doc) => doc?.record.id)).toEqual(
    before.map((doc) => doc?.record.id)
  )
  expect(after.map((doc) => doc?.version)).toEqual([2, 2, 2])
  expect(after.map((doc) => doc?.value)).toEqual([
    { value: legacy.document, workflowVersion: 1 },
    { planId: legacy.input.id, cancelled: false, workflowVersion: 1 },
    { digest: legacy.digest, receipt: legacy.receiptText, workflowVersion: 1 },
  ])
  expect(
    await f.stored("plans.revision", `${legacy.input.id}:1`)
  ).toMatchObject({
    version: 1,
    value: { value: legacy.history },
  })
  await f.restart()
  expect(
    await Effect.runPromise(f.plans.update(legacy.input, f.state.source))
  ).toEqual(legacy.receipt)
  expect(
    (await Effect.runPromise(f.plans.read(legacy.input.id))).history
  ).toHaveLength(1)
})

for (const kind of ["plans.task", "plans.turn", "plans.operation"] as const) {
  it.each(["workflow", "native", "legacy-workflow"] as const)(
    `rejects a future %s version of ${kind} without committing partial legacy upgrades`,
    async (version) => {
      const f = await nativePi(),
        legacy = await seedLegacy(f),
        input: PlanUpdate = {
          ...legacy.input,
          operationId: "tool:2",
          relation: "continue",
          expectedRevision: 1,
        }
      await f.harness.commit(async (tx) => {
        await tx.doc(LegacyOperation, input.operationId, null)
      }, ctx)
      const keys = [
        ["plans.catalog", undefined],
        ["plans.task", input.id],
        ["plans.turn", f.state.source.turnId],
        ["plans.operation", input.operationId],
        ["plans.operation", legacy.input.operationId],
        ["plans.revision", `${input.id}:1`],
      ] as const
      const key =
        kind === "plans.task"
          ? input.id
          : kind === "plans.turn"
            ? f.state.source.turnId
            : input.operationId
      const stored = await f.stored(kind, key)
      expect(stored).toBeDefined()
      await f.storage.commit(
        [
          {
            type: "document.change",
            id: stored!.record.id,
            content: {
              kind: "base",
              version:
                version === "native"
                  ? 3
                  : version === "legacy-workflow"
                    ? 1
                    : 2,
              value: {
                ...stored!.value,
                workflowVersion: version === "native" ? 1 : 2,
              },
            },
          },
        ],
        ctx
      )
      await f.restart()
      const before = await Promise.all(
        keys.map(([family, id]) => f.stored(family, id))
      )
      const exit = await Effect.runPromiseExit(
        f.plans.update(input, f.state.source)
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        if (version === "legacy-workflow") {
          expect(Cause.hasDies(exit.cause)).toBe(true)
          expect(Cause.hasFails(exit.cause)).toBe(false)
        } else {
          expect(Cause.hasDies(exit.cause)).toBe(false)
          expect(exit.cause.reasons).toEqual([
            expect.objectContaining({
              _tag: "Fail",
              error: expect.objectContaining({
                code: "unavailable",
                message: expect.stringContaining(
                  "compatible application version"
                ),
              }),
            }),
          ])
        }
      }
      if (kind === "plans.task" && version !== "legacy-workflow") {
        const response = await Effect.runPromise(
          plansRequest(
            f.plans,
            new Request(`https://example.test/plans/${input.id}`),
            `plans/${input.id}`
          )
        )
        expect(response.status).toBe(503)
        const body = await response.json()
        expect(body).toMatchObject({
          code: "unavailable",
          error: expect.stringContaining("compatible application version"),
        })
        expect(JSON.stringify(body)).not.toContain("Retry the same update")
      }
      expect(
        await Promise.all(keys.map(([family, id]) => f.stored(family, id)))
      ).toEqual(before)
      expect(await f.stored("plans.revision", `${input.id}:2`)).toBeUndefined()
    }
  )
}

it.each([false, true])(
  "joins a persisted update acknowledgment after caller interruption and respects domain cancellation=%s on replay",
  async (cancelled) => {
    const f = await nativePi(),
      input = update(f.state.source),
      origin = f.state.source,
      persisted = deferred(),
      acknowledge = deferred(),
      commit = f.harness.commit.bind(f.harness)
    let first = true,
      settled = false
    f.harness.commit = async (change, context) => {
      const held = first
      first = false
      const value = await commit(change, context)
      if (held) {
        persisted.resolve()
        await acknowledge.promise
      }
      return value
    }
    const controller = new AbortController()
    const pending = Effect.runPromiseExit(f.plans.update(input, origin), {
      signal: controller.signal,
    }).then((exit) => {
      settled = true
      return exit
    })
    await persisted.promise
    controller.abort()
    expect(settled).toBe(false)
    const savedOperation = await f.stored("plans.operation", input.operationId)
    const receipt = JSON.parse(
      String(savedOperation?.value.receipt)
    ) as PlanReceipt
    expect(receipt).toMatchObject({
      id: input.id,
      revision: 1,
      state: "completed",
    })
    if (cancelled) await Effect.runPromise(f.plans.cancel(origin.turnId))
    acknowledge.resolve()
    const exit = await pending
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    await f.restart()
    f.state.source = {
      ...origin,
      inputRevision: 1,
      inputIds: [...origin.inputIds, crypto.randomUUID()],
    }
    if (cancelled) {
      expect(
        await Effect.runPromise(
          f.plans.update(input, origin).pipe(Effect.result)
        )
      ).toMatchObject({
        _tag: "Failure",
        failure: { code: "cancelled" },
      })
    } else {
      expect(await Effect.runPromise(f.plans.update(input, origin))).toEqual(
        receipt
      )
      expect(
        await Effect.runPromise(
          f.plans
            .update({ ...input, reason: "Different content" }, origin)
            .pipe(Effect.result)
        )
      ).toMatchObject({
        _tag: "Failure",
        failure: { code: "conflict" },
      })
    }
    expect(
      (await f.stored("plans.operation", input.operationId))?.value
    ).toEqual(savedOperation?.value)
    const detail = await Effect.runPromise(f.plans.read(input.id))
    expect(detail.plan.state).toBe(cancelled ? "cancelled" : "completed")
    expect(detail.plan.revision).toBe(cancelled ? 2 : 1)
    expect(detail.history).toHaveLength(cancelled ? 2 : 1)
    if (cancelled) expect(detail.history[0]?.reason).toBe("Run cancelled")
  }
)

it("persists completed-plan evidence invalidation once across restart while retaining the original replay receipt", async () => {
  const f = await nativePi(),
    input = update(f.state.source),
    receipt = await Effect.runPromise(f.plans.update(input, f.state.source)),
    originalHistory = await f.stored("plans.revision", `${input.id}:1`),
    originalOperation = await f.stored("plans.operation", input.operationId)
  await f.restart()
  f.state.evidence = (ref) =>
    Effect.succeed({ ...ref, state: "invalid", detail: "Artifact replaced" })
  const reopened = await Effect.runPromise(f.plans.read(input.id))
  expect(reopened.plan).toMatchObject({
    revision: 2,
    state: "open",
    complete: false,
    steps: [{ status: "pending" }],
  })
  expect(reopened.history[0]).toMatchObject({
    actor: "system",
    reason: "Evidence revalidated",
  })
  await f.restart()
  expect((await Effect.runPromise(f.plans.read(input.id))).plan).toEqual(
    reopened.plan
  )
  expect(
    await Effect.runPromise(f.plans.update(input, f.state.source))
  ).toEqual(receipt)
  expect(await f.stored("plans.revision", `${input.id}:1`)).toEqual(
    originalHistory
  )
  expect(await f.stored("plans.operation", input.operationId)).toEqual(
    originalOperation
  )
  expect(await f.stored("plans.revision", `${input.id}:3`)).toBeUndefined()
})

it("joins late readonly acquisition and preserves every partial native cleanup Cause", async () => {
  const f = await nativePi(),
    acquired = deferred(),
    acquireRelease = deferred(),
    closeEntered = deferred(),
    closeRelease = deferred(),
    reader = await openNodeSqliteStorage(f.path),
    realClose = reader.close.bind(reader),
    query = vi.spyOn(reader, "findDocument"),
    commit = vi.spyOn(reader, "commit"),
    failure = new PlanFailure({
      code: "unavailable",
      message: "Readonly close incomplete",
    }),
    defect = new Error("Native reader teardown defect")
  const close = vi
    .spyOn(reader, "close")
    .mockImplementation(async (context) => {
      await realClose(context)
      closeEntered.resolve()
      await closeRelease.promise
      throw Cause.fromReasons([
        Cause.makeFailReason(failure),
        Cause.makeDieReason(defect),
        Cause.makeInterruptReason(),
      ])
    })
  const controller = new AbortController()
  let settled = false
  const pending = Effect.runPromiseExit(
    planBlockerStatus(
      () => undefined,
      async () => {
        acquired.resolve()
        await acquireRelease.promise
        return reader
      },
      f.state.source.turnId
    ),
    { signal: controller.signal }
  ).then((exit) => {
    settled = true
    return exit
  })
  await acquired.promise
  controller.abort()
  acquireRelease.resolve()
  await closeEntered.promise
  expect(settled).toBe(false)
  expect(close).toHaveBeenCalledOnce()
  expect(query).not.toHaveBeenCalled()
  expect(commit).not.toHaveBeenCalled()
  closeRelease.resolve()
  const exit = await pending
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(Cause.hasFails(exit.cause)).toBe(false)
    expect(Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(exit.cause.reasons).toContainEqual(
      expect.objectContaining({ _tag: "Die", defect })
    )
    expect(exit.cause.reasons).toContainEqual(
      expect.objectContaining({
        _tag: "Die",
        defect: expect.objectContaining({ _tag: "Fail", error: failure }),
      })
    )
  }
})

it("rejects malformed lifecycle events at each machine boundary", () => {
  const origin = source(),
    input = update(origin)
  expect(() =>
    advancePlanBinding(
      { planId: "", cancelled: false },
      { type: "BIND", id: "not-a-plan-id" }
    )
  ).toThrow()
  expect(() =>
    advancePlanOperation(
      { digest: "", receipt: null },
      {
        type: "COMMIT",
        digest: "digest",
        receipt: {
          id: input.id,
          revision: -1,
          state: "completed",
          reopened: [],
        },
      }
    )
  ).toThrow()
  expect(() =>
    revisePlan(
      null,
      { ...input, expectedRevision: -1 },
      origin,
      [],
      "2026-10-23T00:00:00.000Z"
    )
  ).toThrow()
})

it.each([
  "completion-projection",
  "completed-step",
  "receipt-consistency",
] as const)(
  "keeps legacy %s corruption fatal through native migration without committing any document",
  async (mode) => {
    const f = await nativePi(),
      legacy = await seedLegacy(f)
    await f.harness.commit(async (tx) => {
      if (mode === "receipt-consistency") {
        const operation = await tx.doc(
          LegacyOperation,
          legacy.input.operationId,
          null
        )
        operation.receipt = ""
      } else {
        const doc = await tx.doc(LegacyPlan, legacy.input.id, null)
        const plan: Plan = JSON.parse(doc.value)
        doc.value = JSON.stringify(
          mode === "completion-projection"
            ? { ...plan, complete: false }
            : {
                ...plan,
                steps: plan.steps.map((step) => ({
                  ...step,
                  status: "pending",
                })),
              }
        )
      }
    }, ctx)
    await f.restart()
    const keys = [
      ["plans.catalog", undefined],
      ["plans.task", legacy.input.id],
      ["plans.turn", f.state.source.turnId],
      ["plans.operation", legacy.input.operationId],
      ["plans.revision", `${legacy.input.id}:1`],
    ] as const
    const before = await Promise.all(
      keys.map(([kind, key]) => f.stored(kind, key))
    )
    const exit = await Effect.runPromiseExit(
      mode === "receipt-consistency"
        ? f.plans.update(legacy.input, f.state.source).pipe(Effect.asVoid)
        : f.plans.read(legacy.input.id).pipe(Effect.asVoid)
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true)
      expect(Cause.hasFails(exit.cause)).toBe(false)
    }
    if (mode !== "receipt-consistency") {
      const http = await Effect.runPromiseExit(
        plansRequest(
          f.plans,
          new Request(`https://example.test/plans/${legacy.input.id}`),
          `plans/${legacy.input.id}`
        )
      )
      expect(Exit.isFailure(http) && Cause.hasDies(http.cause)).toBe(true)
    }
    expect(
      await Promise.all(keys.map(([kind, key]) => f.stored(kind, key)))
    ).toEqual(before)
  }
)
