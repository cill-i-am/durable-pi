import { Cause, Effect, Exit, ManagedRuntime } from "effect"
import { describe, expect, it, vi } from "vitest"

import type {
  FamilyAdmissionError,
  FamilyGeneration,
  FamilyState,
} from "../src/agents/family"
import {
  FamilyAdmission,
  familyAdmissionApplication,
} from "../src/agents/family-admission"
import { conversationPump } from "../src/conversations/pump"
import { CredentialUnavailable } from "../src/inference/credentials"
import { routinePump } from "../src/routines/pump"
import { conversationFixture } from "./conversation-fixture"
import { database } from "./database"
import { routineFixture, run } from "./routine-fixture"

const member: FamilyState = {
  owner: "member",
  modelOwner: "owner",
  joinedAt: 1,
  membershipId: "original-membership",
}
const latch = () => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
async function fixture(status: "active" | "paused" = "active") {
  const db = database(),
    routines = routineFixture(db, () => true),
    conversation = await Effect.runPromise(conversationFixture(db))
  const routine = routines.save({
    id: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    expectedRevision: 0,
    title: "Check",
    prompt: "Read saved facts.",
    status,
    schedule: { type: "once", at: Date.now() + 3600_000 },
  }).routine
  const pending = routines.runNow({
    id: routine.id,
    operationId: crypto.randomUUID(),
    expectedRevision: 1,
  }).run!
  let state: FamilyState | null = member,
    generation: FamilyGeneration = {
      schemaVersion: 1,
      workflowVersion: 1,
      membershipId: member.membershipId,
    }
  const read = vi.fn(() => Effect.sync(() => state)),
    fence = vi.fn(() =>
      Effect.gen(function* () {
        // Match the production fence's routine pause and conversation Stop effects.
        for (const row of yield* routines.service.list()) {
          if (row.status !== "active") continue
          yield* routines.service.setStatus({
            id: row.id,
            expectedRevision: row.revision,
            operationId: crypto.randomUUID(),
            status: "paused",
          })
        }
        for (const turn of yield* conversation.store.unfinished())
          yield* conversation.store.requestStop(turn.id)
      })
    )
  const runtime = ManagedRuntime.make(
    familyAdmissionApplication({
      read,
      generation: () => Effect.sync(() => generation),
      write: (next) =>
        Effect.sync(() => {
          generation = next
        }),
      fence,
    })
  )
  const authority = await runtime.runPromise(FamilyAdmission),
    canAdmit = vi.fn(() => authority.admit.pipe(Effect.map(Boolean))),
    started = latch(),
    released = latch()
  const host = {
    canAdmit,
    modelConnected: () => Effect.succeed(true),
    prearm: () =>
      Effect.promise(async () => {
        started.release()
        await released.promise
        return Date.now() + 60_000
      }),
    getTurn: (id: string) => conversation.store.get(id),
    admission: {
      transactionGroup: db,
      admit: (row: typeof pending, discoveryDeadline: number) =>
        conversation.store
          .admit(
            { operationId: row.turnId, text: row.prompt },
            undefined,
            [],
            undefined,
            { discoveryDeadline }
          )
          .pipe(Effect.map(({ turn }) => turn.id)),
    },
    stop: (id: string, discoveryDeadline?: number) =>
      conversation.store
        .requestStop(id, { discoveryDeadline })
        .pipe(Effect.asVoid),
    notify: () => Effect.void,
    wakeConversation: () => Effect.void,
  }
  return {
    routines,
    conversation,
    pending,
    authority,
    runtime,
    host,
    read,
    fence,
    started,
    released,
    revoke: () => {
      state = null
    },
  }
}

describe("routine admission current family authority", () => {
  it("rechecks membership after awaited discovery before committing a turn", async () => {
    const f = await fixture()
    try {
      const allowDispatch = !!(await Effect.runPromise(f.authority.admit))
      const running = Effect.runPromise(
        routinePump(f.routines.service, f.host).run(undefined, {
          allowDispatch,
        })
      )
      await f.started.promise
      f.revoke()
      f.released.release()
      await running
      expect(run(f.conversation.store.recent())).toHaveLength(0)
      expect(f.routines.runs()[0]).toMatchObject({
        id: f.pending.id,
        status: "cancelled",
      })
      expect(f.fence).toHaveBeenCalledTimes(1)
      expect(f.host.canAdmit).toHaveBeenCalledTimes(1)
    } finally {
      f.released.release()
      await f.runtime.dispose()
    }
  })

  it("negative control: cached admission allows a stale turn, while Conversation authority still blocks native submit", async () => {
    const f = await fixture()
    try {
      const allowDispatch = !!(await Effect.runPromise(f.authority.admit))
      const pump = routinePump(f.routines.service, {
        ...f.host,
        canAdmit: () => Effect.succeed(allowDispatch),
      })
      const running = Effect.runPromise(pump.run(undefined, { allowDispatch }))
      await f.started.promise
      f.revoke()
      f.released.release()
      await running
      expect(run(f.conversation.store.recent())).toHaveLength(1)
      expect(f.routines.inFlight()).toMatchObject({
        id: f.pending.id,
        status: "queued",
      })
      const c = f.conversation
      await Effect.runPromise(
        conversationPump(c.conversations, c.memory, c.journal, c.execution, {
          ...c.host,
          canRun: (id) =>
            f.authority.admit.pipe(
              Effect.flatMap((current) =>
                current ? f.routines.service.canRun(id) : Effect.succeed(false)
              )
            ),
        }).run()
      )
      expect(c.events).not.toContain("submit")
      expect(run(c.store.get(f.pending.turnId))?.status).toBe("cancelled")
      expect(f.fence).toHaveBeenCalledTimes(1)
    } finally {
      f.released.release()
      await f.runtime.dispose()
    }
  })

  it("preserves a healthy original run and native turn identity", async () => {
    const f = await fixture()
    try {
      const allowDispatch = !!(await Effect.runPromise(f.authority.admit))
      f.released.release()
      await Effect.runPromise(
        routinePump(f.routines.service, f.host).run(undefined, {
          allowDispatch,
        })
      )
      expect(f.routines.inFlight()).toMatchObject({
        id: f.pending.id,
        turnId: f.pending.turnId,
        status: "queued",
      })
      const c = f.conversation
      await Effect.runPromise(
        conversationPump(c.conversations, c.memory, c.journal, c.execution, {
          ...c.host,
          canRun: () => f.authority.admit.pipe(Effect.map(Boolean)),
        }).run()
      )
      expect(c.events.filter((event) => event === "submit")).toHaveLength(1)
      expect(run(c.store.get(f.pending.turnId))?.status).toBe("running")
      expect(f.fence).not.toHaveBeenCalled()
    } finally {
      f.released.release()
      await f.runtime.dispose()
    }
  })

  it("fails closed on a fresh authority error while cleanup-only passes still settle admitted work", async () => {
    const f = await fixture()
    try {
      f.released.release()
      const failure = new CredentialUnavailable({
        message: "Family directory unavailable",
      })
      const canAdmit = vi.fn(() => Effect.fail(failure))
      const pump = routinePump<FamilyAdmissionError>(f.routines.service, {
        ...f.host,
        canAdmit,
      })
      const result = await Effect.runPromiseExit(pump.run())
      expect(Exit.isFailure(result) && Cause.hasFails(result.cause)).toBe(true)
      expect(run(f.conversation.store.recent())).toHaveLength(0)
      expect(f.routines.inFlight()?.status).toBe("pending")
      await Effect.runPromise(routinePump(f.routines.service, f.host).run())
      await Effect.runPromise(f.routines.service.requestStopRun(f.pending.id))
      canAdmit.mockClear()
      await Effect.runPromise(pump.run(undefined, { allowDispatch: false }))
      expect(canAdmit).not.toHaveBeenCalled()
      expect(run(f.conversation.store.get(f.pending.turnId))?.status).toBe(
        "stopping"
      )
      const c = f.conversation
      await Effect.runPromise(
        conversationPump(
          c.conversations,
          c.memory,
          c.journal,
          c.execution,
          c.host
        ).run()
      )
      await Effect.runPromise(pump.run(undefined, { allowDispatch: false }))
      expect(f.routines.runs()[0]?.status).toBe("cancelled")
      expect(c.events).not.toContain("submit")
    } finally {
      f.released.release()
      await f.runtime.dispose()
    }
  })
})
