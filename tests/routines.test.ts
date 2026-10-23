import { Schema, Effect, Clock, Exit, Cause, Context } from "effect"
import { describe, expect, it, vi } from "vitest"

import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import {
  SaveRoutine,
  followingTime,
  ROUTINE_BUDGET_MS,
} from "../src/routines/contracts"
import { RoutineStorageError } from "../src/routines/persistence"
import { routinePump } from "../src/routines/pump"
import { database, corrupt } from "./database"
import {
  routineFixture,
  fixtureClock,
  run as runFixture,
} from "./routine-fixture"

function fixture() {
  const db = database()
  let now = 1000000,
    active = true
  const store = routineFixture(
    db,
    () => active,
    () => now
  )
  const input: SaveRoutine = {
    id: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    expectedRevision: 0,
    title: "Morning check",
    prompt: "Review the saved tasks and report meaningful changes.",
    schedule: { type: "interval", at: now + 60000, minutes: 60 },
    status: "active",
  }
  const routine = store.save(input).routine
  return {
    db,
    now: () => now,
    store,
    input,
    routine,
    advance: (ms: number) => {
      now += ms
    },
    archive: () => {
      active = false
    },
    restore: () => {
      active = true
    },
  }
}
const status = (
  f: ReturnType<typeof fixture>,
  value: "paused" | "active" | "archived"
) =>
  f.store.setStatus({
    id: f.routine.id,
    operationId: crypto.randomUUID(),
    expectedRevision: f.store.get(f.routine.id)!.revision,
    status: value,
  })

describe("durable bot routines", () => {
  it("preserves typed conversation persistence failure and keeps its run pending", () => {
    const f = fixture(),
      conversations = new ConversationStore(f.db, {
        model: "test",
        thinking: "off",
      })
    f.advance(60000)
    f.store.claimDue()
    f.db.run(
      "CREATE TRIGGER reject_routine_turn BEFORE INSERT ON chat_turns BEGIN SELECT RAISE(ABORT,'admission failure'); END"
    )
    expect(
      Effect.runSync(
        f.store.service
          .deliver(
            {
              transactionGroup: f.db,
              admit: (value, discoveryDeadline) =>
                conversations
                  .admit(
                    {
                      operationId: value.turnId,
                      text: value.prompt,
                    },
                    undefined,
                    [],
                    undefined,
                    { discoveryDeadline }
                  )
                  .pipe(Effect.map(({ turn }) => turn.id)),
            },
            Date.now() + 60_000
          )
          .pipe(Effect.result)
      )
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ConversationStorageError" },
    })
    expect(f.store.inFlight()?.status).toBe("pending")
    expect(Effect.runSync(conversations.recent())).toHaveLength(0)
  })
  it("refuses a different transaction group before conversation admission", () => {
    const f = fixture(),
      admit = vi.fn(() => Effect.succeed("wrong"))
    f.advance(60000)
    f.store.claimDue()
    expect(() =>
      runFixture(
        f.store.service.deliver(
          { transactionGroup: database(), admit },
          Date.now() + 60_000
        )
      )
    ).toThrow("share its storage transaction group")
    expect(admit).not.toHaveBeenCalled()
    expect(f.store.inFlight()?.status).toBe("pending")
  })
  it("rolls back conversation admission when the queued checkpoint write fails", () => {
    const f = fixture(),
      conversations = new ConversationStore(f.db, {
        model: "test",
        thinking: "off",
      })
    f.advance(60000)
    const pending = f.store.claimDue()!
    f.db.run(
      "CREATE TRIGGER fail_queue BEFORE UPDATE ON routine_runs WHEN NEW.status='queued' BEGIN SELECT RAISE(ABORT,'disk failure'); END"
    )
    expect(() =>
      f.store.deliver((value, discoveryDeadline) => {
        return conversations.admit(
          {
            operationId: value.turnId,
            text: value.prompt,
          },
          undefined,
          [],
          undefined,
          { discoveryDeadline }
        )
      }, Date.now() + 60_000)
    ).toThrow(RoutineStorageError)
    expect(Effect.runSync(conversations.get(pending.turnId))).toBeUndefined()
    expect(f.store.inFlight()?.status).toBe("pending")
    f.db.run("DROP TRIGGER fail_queue")
    f.store.deliver((value, discoveryDeadline) => {
      return conversations.admit(
        {
          operationId: value.turnId,
          text: value.prompt,
        },
        undefined,
        [],
        undefined,
        { discoveryDeadline }
      )
    }, Date.now() + 60_000)
    expect(Effect.runSync(conversations.recent())).toHaveLength(1)
    expect(f.store.inFlight()?.status).toBe("queued")
  })
  it("preserves corrupt durable records as defects rather than expected conflicts", () => {
    const f = fixture()
    corrupt(
      f.db,
      "UPDATE routines SET record='broken' WHERE id=?",
      f.routine.id
    )
    const exit = Effect.runSyncExit(f.store.service.get(f.routine.id))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true)
      expect(Cause.hasFails(exit.cause)).toBe(false)
    }
  })
  it("bounds and validates schedules before accepting intent", () => {
    const f = fixture()
    for (const schedule of [
      { type: "interval", at: 1200000, minutes: 1 },
      { type: "interval", at: 1200000, minutes: 10081 },
      { type: "once", at: NaN },
      { type: "once", at: Infinity },
    ])
      expect(Schema.is(SaveRoutine)({ ...f.input, schedule })).toBe(false)
    for (const at of [0, 1000000, 1000000 + 367 * 86400000])
      expect(() =>
        f.store.save({
          ...f.input,
          operationId: crypto.randomUUID(),
          id: crypto.randomUUID(),
          title: "Different",
          schedule: { type: "once", at },
        })
      ).toThrow("coming year")
    expect(f.store.list()).toHaveLength(1)
  })
  it("replays an exact mutation and rejects changed or stale input", () => {
    const f = fixture()
    expect(f.store.save(f.input).routine).toEqual(f.routine)
    expect(() => f.store.save({ ...f.input, title: "Changed" })).toThrow(
      "another change"
    )
    expect(() =>
      f.store.save({ ...f.input, operationId: crypto.randomUUID() })
    ).toThrow("Reload")
    expect(() =>
      f.store.save({
        ...f.input,
        id: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        title: " morning CHECK ",
      })
    ).toThrow("already exists")
  })
  it("a cancelled operation cannot arrive late and a committed operation resolves as applied", () => {
    const f = fixture(),
      operationId = crypto.randomUUID()
    expect(f.store.cancelOperation(operationId)).toEqual({ applied: false })
    expect(() =>
      f.store.runNow({ id: f.routine.id, expectedRevision: 1, operationId })
    ).toThrow("cancelled")
    expect(f.store.cancelOperation(f.input.operationId)).toEqual({
      applied: true,
    })
    expect(f.store.inFlight()).toBeUndefined()
  })
  it("coalesces missed ticks and never overlaps runs", () => {
    const f = fixture()
    expect(f.store.claimDue()).toBeUndefined()
    f.advance(12 * 3600000)
    const run = f.store.claimDue()!
    expect(run.scheduledAt).toBe(f.routine.nextAt)
    expect(f.store.get(f.routine.id)?.nextAt).toBe(
      1000000 + 12 * 3600000 + 60000
    )
    expect(f.store.claimDue()).toBeUndefined()
    expect(() =>
      f.store.runNow({
        id: f.routine.id,
        expectedRevision: 1,
        operationId: crypto.randomUUID(),
      })
    ).toThrow("already has a routine")
    expect(followingTime({ type: "once", at: 42 }, 42, 100)).toBeNull()
  })
  it("shares an atomic transaction with conversation admission and survives restart once", () => {
    const f = fixture(),
      conversations = new ConversationStore(f.db, {
        model: "test",
        thinking: "off",
      })
    f.advance(60000)
    const run = f.store.claimDue()!
    expect(() =>
      f.store.deliver((value, discoveryDeadline) => {
        return conversations
          .admit(
            { operationId: value.turnId, text: value.prompt },
            undefined,
            [],
            undefined,
            { discoveryDeadline }
          )
          .pipe(Effect.andThen(Effect.die(new Error("rollback"))))
      }, Date.now() + 60_000)
    ).toThrow("rollback")
    expect(Effect.runSync(conversations.get(run.turnId))).toBeUndefined()
    expect(f.store.inFlight()?.status).toBe("pending")
    const restored = routineFixture(
      f.db,
      () => true,
      () => 1060000
    )
    restored.deliver(
      (value, discoveryDeadline) =>
        conversations.admit(
          { operationId: value.turnId, text: value.prompt },
          undefined,
          [],
          undefined,
          { discoveryDeadline }
        ),
      Date.now() + 60_000
    )
    restored.deliver(() => {
      throw new Error("duplicate")
    }, Date.now() + 60_000)
    expect(Effect.runSync(conversations.recent())).toHaveLength(1)
    expect(restored.inFlight()).toMatchObject({
      turnId: run.turnId,
      status: "queued",
      deadline: 1060000 + ROUTINE_BUDGET_MS,
    })
  })
  it("pause cancels unadmitted once work; resume can reclaim it", () => {
    const f = fixture()
    f.store.save({
      ...f.input,
      operationId: crypto.randomUUID(),
      expectedRevision: 1,
      schedule: { type: "once", at: 1060000 },
    })
    f.advance(60000)
    const first = f.store.claimDue()!
    status(f, "paused")
    expect(f.store.inFlight()).toBeUndefined()
    expect(f.store.runs()[0]).toMatchObject({
      id: first.id,
      status: "cancelled",
    })
    expect(f.store.claimDue()).toBeUndefined()
    status(f, "active")
    expect(f.store.claimDue()?.id).not.toBe(first.id)
  })
  it("an admitted run retains its original instructions while edits affect the next run", () => {
    const f = fixture()
    f.advance(60000)
    const first = f.store.claimDue()!
    f.store.deliver(() => {}, Date.now() + 60_000)
    status(f, "paused")
    f.store.save({
      ...f.input,
      operationId: crypto.randomUUID(),
      expectedRevision: 2,
      prompt: "New instructions",
      status: "paused",
    })
    expect(f.store.inFlight()?.prompt).toBe(first.prompt)
    expect(f.store.inFlight()?.status).toBe("queued")
    f.store.finish(first.turnId, "done", null)
    expect(f.store.inFlight()).toBeUndefined()
    expect(f.store.nextWake()).toBeUndefined()
  })
  it("archives block new work and edits without leaking between bot databases", () => {
    const f = fixture(),
      sibling = fixture()
    f.advance(60000)
    f.archive()
    expect(f.store.claimDue()).toBeUndefined()
    expect(f.store.nextWake()).toBeUndefined()
    expect(() => status(f, "paused")).toThrow("Restore this bot")
    expect(sibling.store.get(f.routine.id)).toBeUndefined()
    f.restore()
    expect(f.store.claimDue()).toBeDefined()
  })
  it("restoring an archived routine rejects an active duplicate name", () => {
    const f = fixture()
    status(f, "archived")
    f.store.save({
      ...f.input,
      id: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
    })
    expect(() => status(f, "paused")).toThrow("uses this name")
  })
  it("run-now works while paused with one stable receipt and a ten-minute budget", () => {
    const f = fixture()
    status(f, "paused")
    const input = {
      id: f.routine.id,
      expectedRevision: 2,
      operationId: crypto.randomUUID(),
    }
    const first = f.store.runNow(input).run!
    expect(f.store.runNow(input).run?.id).toBe(first.id)
    f.advance(86400000)
    expect(f.store.canRun(first.turnId)).toBe(true)
    f.store.deliver(() => {}, Date.now() + 60_000)
    f.advance(ROUTINE_BUDGET_MS - 1)
    expect(f.store.canRun(first.turnId)).toBe(true)
    f.advance(1)
    expect(f.store.canRun(first.turnId)).toBe(false)
    expect(f.store.canRun("an-owner-turn")).toBe(true)
    f.store.finish(first.turnId, "cancelled", "Budget expired")
    expect(f.store.runs()[0]?.error).toBe("Budget expired")
  })
  it("stopping a pending run does not admit it later", () => {
    const f = fixture()
    const first = f.store.runNow({
      id: f.routine.id,
      expectedRevision: 1,
      operationId: crypto.randomUUID(),
    }).run!
    f.store.cancelPendingRun(first.id)
    f.store.deliver(() => {
      throw new Error("late admission")
    }, Date.now() + 60_000)
    expect(f.store.runs()[0]?.status).toBe("cancelled")
  })
})

describe("routine alarm reconciliation", () => {
  function scheduled() {
    const f = fixture()
    const conversations = new ConversationStore(f.db, {
      model: "test",
      thinking: "off",
    })
    const host = {
      getTurn: (id: string) => conversations.get(id),
      modelConnected: vi.fn(async () => true),
      prearm: vi.fn(async () => Date.now() + 60_000),
      wakeConversation: vi.fn(async () => {}),
      admit: vi.fn(
        (
          run: { turnId: string; prompt: string },
          discoveryDeadline: number
        ) => {
          return conversations
            .admit(
              {
                operationId: run.turnId,
                text: run.prompt,
              },
              undefined,
              [],
              undefined,
              { discoveryDeadline }
            )
            .pipe(Effect.map(({ turn }) => turn.id))
        }
      ),
      stop: vi.fn((id: string, discoveryDeadline?: number) => {
        return conversations
          .requestStop(id, { discoveryDeadline })
          .pipe(Effect.asVoid)
      }),
      notify: vi.fn(),
    }
    const reconciliation = routinePump(f.store.service, {
      getTurn: (id) => host.getTurn(id),
      modelConnected: () =>
        Effect.tryPromise({
          try: () => host.modelConnected(),
          catch: (cause) => cause,
        }),
      prearm: () =>
        Effect.tryPromise({
          try: () => host.prearm(),
          catch: (cause) => cause,
        }),
      wakeConversation: () =>
        Effect.tryPromise({
          try: () => host.wakeConversation(),
          catch: (cause) => cause,
        }),
      admission: { transactionGroup: f.db, admit: host.admit },
      stop: (id, discoveryDeadline) => host.stop(id, discoveryDeadline),
      notify: () => Effect.sync(host.notify),
    })
    const clock = fixtureClock(f.now)
    const pump = {
      run: () =>
        Effect.runPromise(
          reconciliation.run().pipe(Effect.provideService(Clock.Clock, clock))
        ),
      retry: () =>
        Effect.runSync(
          reconciliation.retry().pipe(Effect.provideService(Clock.Clock, clock))
        ),
    }
    f.advance(60000)
    return { f, conversations, host, pump }
  }
  it.each(["modelConnected", "prearm"] as const)(
    "retains a future wake after exhausted %s errors and resumes once",
    async (method) => {
      const { f, conversations, host, pump } = scheduled()
      host[method].mockRejectedValueOnce(
        new Error("Temporary transport failure")
      )
      await expect(pump.run()).rejects.toThrow("Temporary")
      const retryAt = pump.retry()!
      expect(retryAt).toBe(f.now() + 60000)
      expect(Effect.runSync(conversations.recent())).toHaveLength(0)
      expect(f.store.inFlight()?.status).toBe("pending")
      f.advance(retryAt - f.now())
      await pump.run()
      await pump.run()
      expect(Effect.runSync(conversations.recent())).toHaveLength(1)
      expect(host.admit).toHaveBeenCalledOnce()
      expect(f.store.inFlight()?.status).toBe("queued")
      f.archive()
      expect(pump.retry()).toBeUndefined()
    }
  )
  it("rolls back both owners when the supplied discovery lease has expired", async () => {
    const { f, conversations, host, pump } = scheduled()
    host.prearm.mockResolvedValueOnce(1)
    await expect(pump.run()).rejects.toMatchObject({
      _tag: "ConversationStorageError",
      operation: "admission discovery",
    })
    expect(f.store.inFlight()?.status).toBe("pending")
    expect(Effect.runSync(conversations.recent())).toHaveLength(0)
    expect(host.wakeConversation).not.toHaveBeenCalled()
    expect(host.notify).not.toHaveBeenCalled()
  })
  it("retains one committed admission when its immediate wake fails", async () => {
    const { f, conversations, host, pump } = scheduled()
    host.wakeConversation.mockRejectedValueOnce(
      new Error("Immediate wake unavailable")
    )
    await expect(pump.run()).rejects.toThrow("Immediate wake unavailable")
    expect(f.store.inFlight()?.status).toBe("queued")
    expect(Effect.runSync(conversations.recent())).toHaveLength(1)
    await pump.run()
    expect(host.admit).toHaveBeenCalledOnce()
    expect(host.wakeConversation).toHaveBeenCalledOnce()
  })
  it("does not wake when a competing transaction cancels the pending run", async () => {
    const { f, conversations, host, pump } = scheduled()
    host.prearm.mockImplementationOnce(async () => {
      f.store.cancelPendingRun(f.store.inFlight()!.id)
      return Date.now() + 60_000
    })
    await pump.run()
    expect(f.store.inFlight()).toBeUndefined()
    expect(Effect.runSync(conversations.recent())).toHaveLength(0)
    expect(host.admit).not.toHaveBeenCalled()
    expect(host.wakeConversation).not.toHaveBeenCalled()
  })
  it("persists Stop even when discovery cannot be armed and propagates that failure", async () => {
    const { f, conversations, host, pump } = scheduled()
    await pump.run()
    const admitted = f.store.inFlight()!
    f.advance(ROUTINE_BUDGET_MS)
    host.prearm.mockRejectedValueOnce(new Error("Stop discovery unavailable"))
    await expect(pump.run()).rejects.toThrow("Stop discovery unavailable")
    expect(host.stop).toHaveBeenCalledWith(admitted.turnId, undefined)
    expect(Effect.runSync(conversations.get(admitted.turnId))?.status).toBe(
      "stopping"
    )
  })
  it.each([false, true])(
    "retains all prearm and Stop failure reasons (Stop fails: %s)",
    async (stopFails) => {
      const { f, conversations, pump } = scheduled()
      await pump.run()
      const admitted = f.store.inFlight()!
      f.advance(ROUTINE_BUDGET_MS)
      class Marker extends Context.Service<Marker, string>()(
        "RoutineStopCause"
      ) {}
      const prearmReasons = [
        Cause.makeFailReason(new Error("Discovery unavailable")),
        Cause.makeDieReason(new Error("Discovery cleanup defect")),
        Cause.makeInterruptReason(812),
      ].map((reason, index) =>
        reason.annotate(Context.make(Marker, `prearm-${index}`))
      )
      const stopReasons = [
        Cause.makeFailReason(new Error("Stop result unavailable")),
        Cause.makeDieReason(new Error("Stop cleanup defect")),
      ].map((reason, index) =>
        reason.annotate(Context.make(Marker, `stop-${index}`))
      )
      let stops = 0
      const reconciliation = routinePump(f.store.service, {
        getTurn: (id) => conversations.get(id),
        modelConnected: () => Effect.succeed(true),
        prearm: () => Effect.failCause(Cause.fromReasons(prearmReasons)),
        admission: {
          transactionGroup: f.db,
          admit: () => Effect.die("No new admission during Stop"),
        },
        stop: (id, discoveryDeadline) =>
          Effect.gen(function* () {
            stops++
            if (stopFails)
              return yield* Effect.failCause(Cause.fromReasons(stopReasons))
            yield* conversations.requestStop(id, { discoveryDeadline })
          }),
        wakeConversation: () => Effect.die("Original failure must propagate"),
        notify: () => Effect.die("Original failure must propagate"),
      })
      const exit = await Effect.runPromiseExit(
        reconciliation
          .run()
          .pipe(Effect.provideService(Clock.Clock, fixtureClock(f.now)))
      )
      expect(stops).toBe(1)
      expect(Effect.runSync(conversations.get(admitted.turnId))?.status).toBe(
        stopFails ? "queued" : "stopping"
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const expected = [...prearmReasons, ...(stopFails ? stopReasons : [])]
        expect(exit.cause.reasons).toHaveLength(expected.length)
        for (const [index, reason] of expected.entries()) {
          const actual = exit.cause.reasons[index]!
          expect(actual._tag).toBe(reason._tag)
          expect(actual.annotations.get(Marker.key)).toBe(
            reason.annotations.get(Marker.key)
          )
          if (actual._tag === "Fail" && reason._tag === "Fail")
            expect(actual.error).toBe(reason.error)
          if (actual._tag === "Die" && reason._tag === "Die")
            expect(actual.defect).toBe(reason.defect)
          if (actual._tag === "Interrupt" && reason._tag === "Interrupt")
            expect(actual.fiberId).toBe(reason.fiberId)
        }
      }
    }
  )
  it("stops an admitted turn at its deadline and schedules the next tick after completion", async () => {
    const { f, conversations, host, pump } = scheduled()
    await pump.run()
    const admitted = f.store.inFlight()!
    f.advance(ROUTINE_BUDGET_MS)
    await pump.run()
    expect(host.stop).toHaveBeenCalledWith(admitted.turnId, expect.any(Number))
    expect(Effect.runSync(conversations.get(admitted.turnId))?.status).toBe(
      "stopping"
    )
    Effect.runSync(
      conversations.finish(
        Effect.runSync(conversations.get(admitted.turnId))!,
        [{ id: admitted.turnId, delivery: "unanswered" }],
        "",
        null
      )
    )
    await pump.run()
    expect(f.store.inFlight()).toBeUndefined()
    expect(f.store.runs()[0]?.status).toBe("cancelled")
    expect(f.store.nextWake()).toBeGreaterThan(f.now())
  })
})
