import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai"
import {
  Harness,
  createRegistry,
  defineDocFamily,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { it as effectIt } from "@effect/vitest"
import { Cause, Context, Effect, Exit } from "effect"
import { TestClock } from "effect/testing"
import { afterEach, expect, expectTypeOf, it, vi } from "vitest"

import { plansRequest } from "../src/planning/adapters/http"
import {
  piPlanLedger,
  planDigest,
  planNativeOperation,
  planBlockerStatus,
} from "../src/planning/adapters/pi"
import {
  PlanFailure,
  type PlanUpdate,
  type PlanReceipt,
} from "../src/planning/contracts"
import { planningInputSource, type PlanningInput } from "../src/planning/domain"
import type {
  PlanAuthority,
  PlanEvidence,
  PlanSource,
} from "../src/planning/plans"
import { makePlans } from "../src/planning/service"

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
const input = (origin: PlanSource): PlanUpdate => ({
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
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "plan-boundary-")),
    path = join(directory, "pi.sqlite")
  const harness = await Harness.open(
    await openNodeSqliteStorage(path),
    { models: createModels(), registry: createRegistry() },
    ctx
  )
  cleanups.push(async () => {
    await harness.close(ctx)
    await rm(directory, { recursive: true, force: true })
  })
  const state = { source: source(), cancelled: false, evidence: valid }
  const authority: PlanAuthority = {
    current: () => Effect.sync(() => state.source),
    cancelled: () => Effect.sync(() => state.cancelled),
    receipts: () => Effect.sync(() => []),
    evidence: (ref, roots) => state.evidence(ref, roots),
  }
  const ledger = piPlanLedger(
    async () => harness,
    () => authority.evidence
  )
  return {
    harness,
    path,
    state,
    authority,
    ledger,
    plans: makePlans(ledger, authority, planDigest),
  }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

effectIt.effect(
  "evidence composes with caller requirements and Clock inside the native transaction",
  () =>
    Effect.gen(function* () {
      const f = yield* Effect.promise(fixture)
      class Invocation extends Context.Service<
        Invocation,
        { marker: string }
      >()("PlanningInvocation") {}
      const checker: PlanEvidence<Invocation> = (ref) =>
        Invocation.pipe(
          Effect.map((value) => {
            expect(value.marker).toBe("this request")
            return { ...ref, state: "valid" as const, detail: value.marker }
          })
        )
      const plans = makePlans(
        piPlanLedger(
          async () => f.harness,
          () => checker
        ),
        f.authority,
        planDigest
      )
      const mutation = input(f.state.source)
      const work = plans.update(mutation, f.state.source)
      expectTypeOf(work).toEqualTypeOf<
        Effect.Effect<PlanReceipt, PlanFailure, Invocation>
      >()
      yield* TestClock.setTime(25_000)
      yield* work.pipe(
        Effect.provideService(Invocation, { marker: "this request" })
      )
      const detail = yield* plans
        .read(mutation.id)
        .pipe(Effect.provideService(Invocation, { marker: "this request" }))
      expect(detail.plan.createdAt).toBe("1970-01-01T00:00:25.000Z")
      expect(detail.plan.steps[0]?.evidence[0]?.detail).toBe("this request")
    })
)

it("rolls back expected failures and preserves synchronous callback defects", async () => {
  const f = await fixture(),
    id = crypto.randomUUID()
  const failed = await Effect.runPromiseExit(
    f.ledger.atomic((tx) =>
      Effect.gen(function* () {
        ;(yield* tx.catalog()).ids.push(id)
        return yield* new PlanFailure({
          code: "conflict",
          message: "Native callback refused",
        })
      })
    )
  )
  expect(Exit.isFailure(failed) && Cause.hasFails(failed.cause)).toBe(true)
  expect(await Effect.runPromise(f.ledger.catalog())).toEqual([])
  const defect = await Effect.runPromiseExit(
    f.ledger.atomic(() => {
      throw new Error("Callback construction bug")
    })
  )
  expect(Exit.isFailure(defect) && Cause.hasDies(defect.cause)).toBe(true)
  expect(Exit.isFailure(defect) && Cause.hasFails(defect.cause)).toBe(false)
})

it("keeps corrupt plan, history and operation payloads out of expected HTTP failures", async () => {
  const f = await fixture(),
    mutation = input(f.state.source)
  const receipt = await Effect.runPromise(
    f.plans.update(mutation, f.state.source)
  )
  const RawHistory = defineDocFamily({
    checkpointWhen: () => false,
    kind: "plans.revision",
    scope: "session",
    family: true,
    version: 1,
    initial: (_: null) => ({ value: "" }),
  })
  const RawPlan = defineDocFamily({
    checkpointWhen: () => false,
    kind: "plans.task",
    scope: "session",
    family: true,
    version: 2,
    initial: (_: null) => ({ value: "", workflowVersion: 1 }),
  })
  const RawOperation = defineDocFamily({
    checkpointWhen: () => false,
    kind: "plans.operation",
    scope: "session",
    family: true,
    version: 2,
    initial: (_: null) => ({ digest: "", receipt: "", workflowVersion: 1 }),
  })
  let originalHistory = "",
    originalPlan = ""
  await f.harness.commit(async (tx) => {
    const history = await tx.doc(RawHistory, `${mutation.id}:1`, null)
    originalHistory = history.value
    history.value = "private corrupt JSON"
  }, ctx)
  const history = await Effect.runPromiseExit(
    plansRequest(
      f.plans,
      new Request(`https://app.example.com/plans/${mutation.id}`),
      `plans/${mutation.id}`
    )
  )
  expect(Exit.isFailure(history) && Cause.hasDies(history.cause)).toBe(true)
  await f.harness.commit(async (tx) => {
    ;(await tx.doc(RawHistory, `${mutation.id}:1`, null)).value =
      originalHistory
    const doc = await tx.doc(RawPlan, mutation.id, null)
    originalPlan = doc.value
    doc.value = ""
    // A nonempty malformed stored record remains distinguishable from absence.
    doc.value = JSON.stringify({ private: "corrupt plan" })
  }, ctx)
  const plan = await Effect.runPromiseExit(f.plans.read(mutation.id))
  expect(Exit.isFailure(plan) && Cause.hasDies(plan.cause)).toBe(true)
  await f.harness.commit(async (tx) => {
    const doc = await tx.doc(RawPlan, mutation.id, null)
    doc.value = originalPlan
    const operation = await tx.doc(RawOperation, mutation.operationId, null)
    operation.receipt = JSON.stringify({ ...receipt, revision: -1 })
  }, ctx)
  const replay = await Effect.runPromiseExit(
    f.plans.update(mutation, f.state.source)
  )
  expect(Exit.isFailure(replay) && Cause.hasDies(replay.cause)).toBe(true)
})

it("maps expected evidence unavailability while preserving evidence defects without revising saved completion", async () => {
  const f = await fixture(),
    mutation = input(f.state.source)
  await Effect.runPromise(f.plans.update(mutation, f.state.source))
  f.state.evidence = () =>
    Effect.fail(
      new PlanFailure({ code: "unavailable", message: "Evidence unavailable" })
    )
  const response = await Effect.runPromise(
    plansRequest(
      f.plans,
      new Request(`https://app.example.com/plans/${mutation.id}`),
      `plans/${mutation.id}`
    )
  )
  expect(response.status).toBe(503)
  f.state.evidence = () => Effect.die(new Error("Private evidence invariant"))
  const defect = await Effect.runPromiseExit(f.plans.read(mutation.id))
  expect(Exit.isFailure(defect) && Cause.hasDies(defect.cause)).toBe(true)
  expect(
    (
      await Effect.runPromise(
        f.ledger.atomic((tx) =>
          tx.document(mutation.id).pipe(Effect.map((doc) => doc.value))
        )
      )
    )?.revision
  ).toBe(1)
})

it("rejects steering that arrives during evidence evaluation before publication", async () => {
  const f = await fixture(),
    entered = deferred(),
    release = deferred(),
    origin = f.state.source,
    mutation = input(origin)
  f.state.evidence = (ref) =>
    Effect.promise(async () => {
      entered.resolve()
      await release.promise
      return { ...ref, state: "valid" as const, detail: "Saved source" }
    })
  const pending = Effect.runPromise(
    f.plans.update(mutation, origin).pipe(Effect.result)
  )
  await entered.promise
  f.state.source = {
    ...origin,
    inputRevision: 1,
    inputIds: [...origin.inputIds, crypto.randomUUID()],
  }
  release.resolve()
  expect(await pending).toMatchObject({
    _tag: "Failure",
    failure: { code: "conflict" },
  })
  expect(await Effect.runPromise(f.ledger.catalog())).toEqual([])
  expect(
    await Effect.runPromise(f.ledger.binding(origin.turnId))
  ).toBeUndefined()
})

it("keeps persisted root cancellation effective for a later continuation even before reconciliation", async () => {
  const f = await fixture(),
    origin = f.state.source,
    mutation = input(origin)
  await Effect.runPromise(f.plans.update(mutation, origin))
  await Effect.runPromise(
    f.ledger.atomic((tx) =>
      tx.binding(origin.turnId).pipe(
        Effect.map((binding) => {
          binding.cancelled = true
        })
      )
    )
  )
  f.state.source = source()
  const continuation = {
    ...mutation,
    operationId: "tool:2",
    relation: "continue" as const,
    expectedRevision: 1,
  }
  expect(
    await Effect.runPromise(
      f.plans.update(continuation, f.state.source).pipe(Effect.result)
    )
  ).toMatchObject({ _tag: "Failure", failure: { code: "cancelled" } })
  expect((await Effect.runPromise(f.plans.read(mutation.id))).plan.state).toBe(
    "cancelled"
  )
})

it("records cancellation arriving during revalidation and does not reopen a cancelled task", async () => {
  const f = await fixture(),
    mutation = input(f.state.source),
    entered = deferred(),
    release = deferred()
  await Effect.runPromise(f.plans.update(mutation, f.state.source))
  f.state.evidence = (ref) =>
    Effect.promise(async () => {
      entered.resolve()
      await release.promise
      return { ...ref, state: "invalid" as const, detail: "Stale" }
    })
  const pending = Effect.runPromise(f.plans.read(mutation.id))
  await entered.promise
  f.state.cancelled = true
  release.resolve()
  const detail = await pending
  expect(detail.plan).toMatchObject({
    revision: 2,
    state: "cancelled",
    complete: false,
  })
  expect(detail.history[0]?.reason).toBe("Run cancelled")
  expect(
    (await Effect.runPromise(f.plans.read(mutation.id))).plan.revision
  ).toBe(2)
})

it("joins interrupted evidence cleanup inside the native transaction before rollback completes", async () => {
  const f = await fixture(),
    mutation = input(f.state.source),
    entered = deferred(),
    release = deferred(),
    aborted = deferred()
  let alive = false,
    finished = false
  f.state.evidence = (ref) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        alive = true
      }),
      () =>
        planNativeOperation(async (signal) => {
          signal.addEventListener("abort", aborted.resolve, { once: true })
          entered.resolve()
          await release.promise
          return { ...ref, state: "valid" as const, detail: "Saved source" }
        }),
      () =>
        Effect.sync(() => {
          alive = false
        })
    )
  const controller = new AbortController()
  const pending = Effect.runPromiseExit(
    f.plans.update(mutation, f.state.source),
    { signal: controller.signal }
  ).then((result) => {
    finished = true
    return result
  })
  await entered.promise
  controller.abort()
  await aborted.promise
  expect(alive).toBe(true)
  expect(finished).toBe(false)
  release.resolve()
  const result = await pending
  expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true)
  expect(alive).toBe(false)
  expect(await Effect.runPromise(f.ledger.catalog())).toEqual([])
})

it("closes an owned readonly facade acquired after cancellation without querying or committing", async () => {
  const f = await fixture(),
    entered = deferred(),
    release = deferred()
  const reader = await openNodeSqliteStorage(f.path),
    close = vi.spyOn(reader, "close"),
    query = vi.spyOn(reader, "findDocument"),
    commit = vi.spyOn(reader, "commit")
  const controller = new AbortController()
  const pending = Effect.runPromiseExit(
    planBlockerStatus(
      () => undefined,
      async () => {
        entered.resolve()
        await release.promise
        return reader
      },
      f.state.source.turnId
    ),
    { signal: controller.signal }
  )
  await entered.promise
  controller.abort()
  release.resolve()
  const result = await pending
  expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true)
  expect(close).toHaveBeenCalledOnce()
  expect(query).not.toHaveBeenCalled()
  expect(commit).not.toHaveBeenCalled()
})

it("replays committed plan receipts after a lost native acknowledgment", async () => {
  const f = await fixture(),
    mutation = input(f.state.source),
    commit = f.harness.commit.bind(f.harness)
  let loseAck = true
  f.harness.commit = async (change, context) => {
    const result = await commit(change, context)
    if (loseAck) {
      loseAck = false
      throw new Error("Native acknowledgment lost")
    }
    return result
  }
  expect(
    await Effect.runPromise(
      f.plans.update(mutation, f.state.source).pipe(Effect.result)
    )
  ).toMatchObject({ _tag: "Failure", failure: { code: "unavailable" } })
  expect(
    (await Effect.runPromise(f.plans.update(mutation, f.state.source))).revision
  ).toBe(1)
  expect(
    (await Effect.runPromise(f.plans.read(mutation.id))).history
  ).toHaveLength(1)
})

it("projects steering delivery without treating root attachments or offered text as newly reconciled input", () => {
  const rootInput: PlanningInput = {
    id: "root",
    text: "Original request",
    delivery: "queued",
    steering: false,
    hasAttachments: true,
  }
  expect(planningInputSource("root", 4, [rootInput]).pendingInputs).toBe(false)
  const extraInput: PlanningInput = {
    id: "steering",
    text: "Use the attached specification",
    delivery: "accepted",
    steering: true,
    hasAttachments: true,
  }
  const pending = planningInputSource("root", 4, [rootInput, extraInput])
  expect(pending.inputIds).toEqual(["root", "steering"])
  expect(pending.inputRevision).toBe(4)
  expect(pending.pendingInputs).toBe(true)
  expect(pending.steering).toEqual([
    {
      id: "steering",
      text: "Use the attached specification",
      hasAttachments: true,
      nativeDelivered: false,
    },
  ])
  for (const delivery of ["consumed", "answered"] as const) {
    const delivered = planningInputSource("root", 5, [
      rootInput,
      { ...extraInput, delivery },
    ])
    expect(delivered.inputIds).toEqual(pending.inputIds)
    expect(delivered.pendingInputs).toBe(false)
    expect(delivered.steering?.[0]?.nativeDelivered).toBe(true)
  }
  const queuedText = planningInputSource("root", 6, [
    { ...extraInput, delivery: "queued", hasAttachments: false },
  ])
  expect(queuedText.pendingInputs).toBe(true)
  expect(queuedText.steering?.[0]?.nativeDelivered).toBe(false)
  const attachmentOnly = planningInputSource("root", 6, [
    { ...extraInput, text: "" },
  ])
  expect(attachmentOnly.steering?.[0]?.text).toBe(
    "Please inspect the attached files."
  )
  expect(attachmentOnly.pendingInputs).toBe(true)
})
