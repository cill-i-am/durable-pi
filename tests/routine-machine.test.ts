import { Effect } from "effect"
import { Clock } from "effect"
import { describe, expect, it, vi } from "vitest"

import { RoutineConflict, ROUTINE_BUDGET_MS } from "../src/routines/contracts"
import { routinePump } from "../src/routines/pump"
import {
  newRoutineRecord,
  advanceRoutine,
  readRoutineRecord,
  routineAllows,
} from "../src/routines/routine.machine"
import {
  advanceRoutineRun,
  readRoutineRunRecord,
  ROUTINE_ADMISSION_BUDGET_MS,
} from "../src/routines/run.machine"
import { database, corrupt } from "./database"
import { fixtureClock, routineFixture, run } from "./routine-fixture"

const record = () => ({
  id: crypto.randomUUID(),
  title: "Check",
  prompt: "Report saved facts.",
  schedule: { type: "once" as const, at: 2000 },
  status: "active" as const,
  revision: 1,
  nextAt: 2000,
  createdAt: 1000,
  updatedAt: 1000,
})
const pending = () => ({
  id: crypto.randomUUID(),
  routineId: crypto.randomUUID(),
  routineRevision: 1,
  title: "Check",
  prompt: "Report saved facts.",
  turnId: crypto.randomUUID(),
  trigger: "manual" as const,
  scheduledAt: 1000,
  createdAt: 1000,
  status: "pending" as const,
  deadline: null,
  finishedAt: null,
  error: null,
})
function fixture() {
  let now = 1000
  const db = database(),
    store = routineFixture(
      db,
      () => true,
      () => now
    )
  const saved = store.save({
    ...record(),
    expectedRevision: 0,
    operationId: crypto.randomUUID(),
  }).routine
  return {
    db,
    store,
    saved,
    advance: (amount: number) => {
      now += amount
    },
    now: () => now,
  }
}
describe("routine machine restoration and authority", () => {
  it("reconstructs legacy identities without replay and rejects partial/future versions", () => {
    const legacy = record(),
      restored = readRoutineRecord(legacy)
    expect(restored).toMatchObject({
      ...legacy,
      schemaVersion: 1,
      workflowVersion: 1,
    })
    expect(readRoutineRecord(JSON.parse(JSON.stringify(restored)))).toEqual(
      restored
    )
    expect(() => readRoutineRecord({ ...restored, schemaVersion: 2 })).toThrow()
    expect(() => readRoutineRecord({ ...legacy, workflowVersion: 1 })).toThrow()
    const run = pending(),
      resumed = readRoutineRunRecord(run)
    expect(resumed).toMatchObject({
      id: run.id,
      turnId: run.turnId,
      admissionDeadline: 1000 + ROUTINE_ADMISSION_BUDGET_MS,
      controlRevision: 0,
    })
    expect(() =>
      readRoutineRunRecord({ ...resumed, workflowVersion: 2 })
    ).toThrow()
    expect(() =>
      readRoutineRunRecord({ ...resumed, status: "queued" })
    ).toThrow("deadline")
  })
  it("uses machine guards for paused manual runs and fences stale admission revisions", () => {
    const initial = newRoutineRecord(record())
    const paused = advanceRoutine(initial, {
      type: "STATUS",
      status: "paused",
      nextAt: 2000,
      now: 1100,
    })
    expect(
      routineAllows(paused, { type: "TRIGGER", trigger: "manual", now: 3000 })
    ).toBe(true)
    expect(
      routineAllows(paused, {
        type: "TRIGGER",
        trigger: "scheduled",
        now: 3000,
      })
    ).toBe(false)
    expect(
      routineAllows(paused, {
        type: "ADMIT",
        trigger: "webhook",
        revision: paused.revision,
      })
    ).toBe(false)
    expect(
      routineAllows(paused, {
        type: "ADMIT",
        trigger: "manual",
        revision: initial.revision,
      })
    ).toBe(false)
    expect(() =>
      advanceRoutine(initial, {
        type: "STATUS",
        status: "paused",
        nextAt: 2000,
        now: -1,
      })
    ).toThrow()
    expect(() =>
      advanceRoutineRun(pending(), { type: "DEADLINE", now: -1 })
    ).toThrow()
  })
  it("preserves finite pending expiry and occupied uncertain native work", () => {
    const first = pending()
    const expired = advanceRoutineRun(first, {
      type: "ADMIT",
      now: 1000 + ROUTINE_ADMISSION_BUDGET_MS,
      allowed: true,
    })
    expect(expired.status).toBe("failed")
    expect(expired.error).toContain("24 hours")
    const admitted = advanceRoutineRun(first, {
      type: "ADMIT",
      now: 2000,
      allowed: true,
    })
    const stopping = advanceRoutineRun(admitted, {
      type: "DEADLINE",
      now: 2000 + ROUTINE_BUDGET_MS,
    })
    const uncertain = advanceRoutineRun(stopping, {
      type: "EXHAUSTED",
      now: 2001 + ROUTINE_BUDGET_MS,
    })
    expect(uncertain).toMatchObject({
      status: "unconfirmed",
      turnId: first.turnId,
      finishedAt: null,
    })
    expect(uncertain.error).toContain("Stop")
    const retry = advanceRoutineRun(uncertain, {
      type: "STOP",
      now: 3000 + ROUTINE_BUDGET_MS,
    })
    expect(retry).toMatchObject({ status: "stopping", turnId: first.turnId })
    expect(
      advanceRoutineRun(retry, {
        type: "FINISH",
        turnId: crypto.randomUUID(),
        status: "done",
        now: 4000 + ROUTINE_BUDGET_MS,
        error: null,
      })
    ).toEqual(retry)
  })
  it("rejects expired discovery before accepting new identities and replays committed receipts", () => {
    const f = fixture(),
      input = {
        id: f.saved.id,
        expectedRevision: 1,
        operationId: crypto.randomUUID(),
      }
    expect(() => run(f.store.service.runNow(input, f.now()))).toThrow(
      RoutineConflict
    )
    expect(f.store.inFlight()).toBeUndefined()
    expect(
      f.db.all("SELECT * FROM routine_operations WHERE id=?", input.operationId)
    ).toHaveLength(0)
    const first = run(f.store.service.runNow(input, f.now() + 10))
    f.advance(20)
    expect(run(f.store.service.runNow(input, 0))).toEqual(first)
  })
  it("fences stale recovery exhaustion after an explicit Stop changes the control revision", () => {
    const f = fixture(),
      first = f.store.runNow({
        id: f.saved.id,
        expectedRevision: 1,
        operationId: crypto.randomUUID(),
      }).run!
    f.store.deliver(() => {}, Date.now() + 60_000)
    const prior = readRoutineRunRecord(f.store.inFlight())
    run(f.store.service.requestStopRun(first.id))
    expect(run(f.store.service.exhaust(prior, () => true))).toBe(false)
    expect(f.store.inFlight()?.status).toBe("stopping")
    const stopped = readRoutineRunRecord(f.store.inFlight())
    expect(run(f.store.service.exhaust(stopped, () => false))).toBe(false)
    expect(run(f.store.service.exhaust(stopped, () => true))).toBe(true)
    expect(f.store.nextWake()).toBeUndefined()
    expect(() =>
      f.store.runNow({
        id: f.saved.id,
        expectedRevision: 1,
        operationId: crypto.randomUUID(),
      })
    ).toThrow("already has")
    run(f.store.service.requestStopRun(first.id))
    expect(f.store.nextWake()).toBeDefined()
    expect(f.store.inFlight()?.turnId).toBe(first.turnId)
  })
  it("rejects future stored routine versions before creating a run", () => {
    const f = fixture()
    corrupt(
      f.db,
      "UPDATE routines SET record=json_set(record,'$.schemaVersion',2) WHERE id=?",
      f.saved.id
    )
    expect(() =>
      f.store.runNow({
        id: f.saved.id,
        expectedRevision: 1,
        operationId: crypto.randomUUID(),
      })
    ).toThrow()
    expect(f.store.runs()).toHaveLength(0)
  })
  it("cleanup-only pumping observes and stops admitted work without claiming another run", async () => {
    const f = fixture()
    const first = f.store.runNow({
      id: f.saved.id,
      expectedRevision: 1,
      operationId: crypto.randomUUID(),
    }).run!
    f.store.deliver(() => {}, Date.now() + 60_000)
    f.advance(ROUTINE_BUDGET_MS)
    const modelConnected = vi.fn(() => Effect.succeed(true)),
      stop = vi.fn(() => Effect.void),
      admit = vi.fn(() => Effect.succeed(first.turnId))
    const pump = routinePump(f.store.service, {
      canAdmit: () => Effect.succeed(true),
      getTurn: () =>
        Effect.succeed({
          id: first.turnId,
          status: "running" as const,
          error: null,
        }),
      modelConnected,
      stop,
      prearm: () => Effect.succeed(Date.now() + 60_000),
      admission: { transactionGroup: f.db, admit },
      wakeConversation: () => Effect.void,
      notify: () => Effect.void,
    })
    await Effect.runPromise(
      pump
        .run(undefined, { allowDispatch: false })
        .pipe(Effect.provideService(Clock.Clock, fixtureClock(f.now)))
    )
    expect(stop).toHaveBeenCalledTimes(1)
    expect(modelConnected).not.toHaveBeenCalled()
    expect(admit).not.toHaveBeenCalled()
    expect(f.store.runs()).toHaveLength(1)
  })
})
