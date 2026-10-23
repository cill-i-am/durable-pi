import { Effect } from "effect"
import { expect, it, vi } from "vitest"

import type { PersonalAgent } from "../src/agent/worker"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { personalCoordination } from "../src/coordination/personal-agent"
import { database } from "./database"

vi.mock("agents/lifecycle", () => ({ LifecycleCapability: class {} }))

function fixture() {
  const db = database(),
    conversations = new ConversationStore(db, {
      model: "test",
      thinking: "off",
    }),
    order: string[] = []
  for (const [id, session] of [
    ["source", "1"],
    ["target", "2"],
  ]) {
    Effect.runSync(
      conversations.admit(
        { operationId: id!, text: "Original request" },
        undefined,
        [],
        undefined,
        { discoveryDeadline: Date.now() + 60_000 }
      )
    )
    Effect.runSync(conversations.saveSession(id!, session!))
    db.run("UPDATE chat_turns SET status='done' WHERE id=?", id!)
  }
  let armFails = false,
    wakeFails = false,
    expired = false,
    deadline = 0
  const owner = {
    db,
    conversations,
    botConfiguration: { read: () => Effect.succeed(undefined) },
    routineAuthority: { canRun: () => Effect.succeed(true) },
    delegationLedger: {
      parent: () => Effect.succeed(undefined),
      catalog: () => Effect.succeed([]),
    },
    delegations: { nextWake: () => Effect.succeed(undefined) },
    active: () => conversations.active(),
    messageProvenance: () => ({ conversationId: "synthetic-bot" }),
    coordinationRunner: {
      wake: async () => {},
      armDiscovery: async () => Date.now() + 60_000,
    },
    notifyConversation: () => {},
    runner: {
      armDiscovery: async () => {
        order.push("prearm")
        expect(Effect.runSync(conversations.active())).toBeUndefined()
        if (armFails) throw new Error("Discovery unavailable")
        deadline = expired ? 0 : Date.now() + 60_000
        return deadline
      },
      wake: async () => {
        order.push("wake")
        expect(Effect.runSync(conversations.active())).toBeDefined()
        if (wakeFails) throw new Error("Wake acknowledgement lost")
      },
    },
  } as unknown as PersonalAgent
  const resumed = vi.spyOn(conversations, "resumeMessage")
  const coordination = personalCoordination(owner)
  return {
    db,
    conversations,
    coordination,
    resumed,
    order,
    deadline: () => deadline,
    set: (options: {
      armFails?: boolean
      wakeFails?: boolean
      expired?: boolean
    }) => {
      armFails = options.armFails ?? armFails
      wakeFails = options.wakeFails ?? wakeFails
      expired = options.expired ?? expired
    },
    send: () =>
      Effect.runPromise(
        coordination.service.send(1, "synthetic-operation", {
          to: { sessionId: "target", agentId: "main" },
          text: "Follow up privately",
        })
      ),
  }
}

it("prearms before the real Coordination admission transaction and carries its deadline", async () => {
  const f = fixture(),
    message = await f.send()
  await Effect.runPromise(f.coordination.pump())
  expect(f.order).toEqual(["prearm", "wake"])
  expect(
    await Effect.runPromise(f.coordination.store.get(message.id))
  ).toMatchObject({ state: "delivered" })
  const turn = await Effect.runPromise(f.conversations.get(message.id))
  expect(turn).toMatchObject({
    session_id: "2",
    origin: { kind: "coordination", messageId: message.id },
  })
  expect(f.resumed).toHaveBeenCalledWith(
    expect.objectContaining({ operationId: message.id }),
    { discoveryDeadline: f.deadline() }
  )
})

it.each(["armFails", "expired"] as const)(
  "retains the Coordination message for retry after %s without accepting a turn",
  async (mode) => {
    const f = fixture(),
      message = await f.send()
    f.set({ [mode]: true })
    await Effect.runPromise(f.coordination.pump())
    expect(f.order).toEqual(["prearm"])
    expect(
      await Effect.runPromise(f.coordination.store.get(message.id))
    ).toMatchObject({ state: "accepted", attempts: 1 })
    expect(
      await Effect.runPromise(f.conversations.get(message.id))
    ).toBeUndefined()
    f.set({ [mode]: false })
    f.db.run("UPDATE agent_messages SET retry_at=0 WHERE id=?", message.id)
    await Effect.runPromise(f.coordination.pump())
    expect(
      await Effect.runPromise(f.coordination.store.get(message.id))
    ).toMatchObject({ state: "delivered" })
    expect(
      await Effect.runPromise(f.conversations.get(message.id))
    ).toBeDefined()
  }
)

it("keeps both Coordination receipt and resumed turn after the immediate wake fails", async () => {
  const f = fixture(),
    message = await f.send()
  f.set({ wakeFails: true })
  await Effect.runPromise(f.coordination.pump())
  expect(
    await Effect.runPromise(f.coordination.store.get(message.id))
  ).toMatchObject({ state: "delivered" })
  expect(await Effect.runPromise(f.conversations.get(message.id))).toBeDefined()
  expect(f.order).toEqual(["prearm", "wake"])
  await Effect.runPromise(f.coordination.service.pump())
  expect(f.order).toEqual(["prearm", "wake"])
})

it("makes cleanup-only passes without admitting addressed conversations", async () => {
  const f = fixture(),
    message = await f.send()
  await Effect.runPromise(f.coordination.pump({ allowDispatch: false }))
  expect(f.order).toEqual([])
  expect(
    await Effect.runPromise(f.coordination.store.get(message.id))
  ).toMatchObject({ phase: "pending" })
  expect(
    await Effect.runPromise(f.conversations.get(message.id))
  ).toBeUndefined()
  await Effect.runPromise(f.coordination.pump({ allowDispatch: true }))
  expect(
    await Effect.runPromise(f.coordination.store.get(message.id))
  ).toMatchObject({ phase: "delivered" })
})
