import { Clock, Effect, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AgentId, homeAgentId, type AgentProfile } from "../src/agents/domain"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { WhatsAppStore } from "../src/whatsapp/adapters/sqlite"
import {
  whatsappIdentity,
  WHATSAPP_WINDOW_MS,
  type IncomingWhatsApp,
} from "../src/whatsapp/contracts"
import { WhatsAppSendFailed } from "../src/whatsapp/pump"
import { whatsappApplication } from "../src/whatsapp/service"
import { database } from "./database"

const run = Effect.runPromise
const child = Schema.decodeUnknownSync(AgentId)(
  "12345678-1234-4234-8234-123456789abc"
)
async function incoming(
  messageId = "wamid.first",
  body = "Help with dinner."
): Promise<IncomingWhatsApp> {
  return {
    ...(await whatsappIdentity(messageId)),
    messageId,
    threadId: "whatsapp:123456:15550101010",
    sender: "15550101010",
    body,
    timestamp: Date.now(),
  }
}
async function fixture() {
  const db = database(),
    store = new WhatsAppStore(db)
  const conversations = new ConversationStore(db, {
    model: "test",
    thinking: "medium",
  })
  const profiles: AgentProfile[] = [homeAgentId, child].map((id) => ({
    id,
    slug: id,
    name: id === homeAgentId ? "Home" : "Research",
    instructions: "",
    status: "active",
    revision: 1,
    createdAt: "today",
    updatedAt: "today",
  }))
  const admissions: { agent: string; id: string }[] = [],
    sends: string[] = []
  let failure: WhatsAppSendFailed | undefined,
    approval = false,
    wakes = 0
  const app = whatsappApplication(store, {
    reconcile: () => Effect.void,
    armReply: () => Effect.void,
    configured: () => true,
    contactUrl: () => null,
    profiles: () => Effect.succeed(profiles),
    active: (id) =>
      Effect.succeed(
        profiles.some(
          (profile) => profile.id === id && profile.status === "active"
        )
      ),
    name: (id) =>
      Effect.succeed(profiles.find((profile) => profile.id === id)!.name),
    reviewUrl: (id) => `https://pi.example.com/agents/${id}`,
    wake: () =>
      Effect.sync(() => {
        wakes++
      }),
    admit: (agent, input) =>
      Effect.gen(function* () {
        admissions.push({ agent, id: input.operationId })
        const now = yield* Clock.currentTimeMillis
        return yield* conversations.admit(input, undefined, [], undefined, {
          discoveryDeadline: now + 60_000,
        })
      }).pipe(Effect.orDie),
    turn: (_agent, id) =>
      conversations.get(id).pipe(
        Effect.orDie,
        Effect.map((turn) =>
          turn
            ? {
                status: turn.status,
                answer: turn.answer,
                needsApproval: approval,
              }
            : undefined
        )
      ),
    send: (_record, text) =>
      Effect.suspend(() => {
        sends.push(text)
        return failure ? Effect.fail(failure) : Effect.succeed("wamid.sent")
      }),
  })
  await run(
    app.configure(
      { operationId: crypto.randomUUID(), revision: 0, enabled: true },
      homeAgentId
    )
  )
  return {
    db,
    store,
    app,
    profiles,
    admissions,
    sends,
    conversations,
    wakes: () => wakes,
    fail: (uncertain: boolean) => {
      failure = new WhatsAppSendFailed({ uncertain })
    },
    clear: () => {
      failure = undefined
    },
    approve: (value: boolean) => {
      approval = value
    },
    complete: (id: string) =>
      db.run(
        "UPDATE chat_turns SET status='done',answer='Pasta tonight.' WHERE id=?",
        id
      ),
  }
}
afterEach(() => vi.useRealTimers())
describe("durable WhatsApp delivery", () => {
  it("dedupes provider redelivery, preserves WhatsApp origin and sends one bounded reply", async () => {
    const f = await fixture(),
      input = await incoming()
    expect(await run(f.app.receive(input))).toBe(true)
    expect(await run(f.app.receive(input))).toBe(false)
    expect(f.wakes()).toBe(2)
    await run(f.app.pump())
    await run(f.app.pump())
    expect(f.admissions).toEqual([{ agent: homeAgentId, id: input.id }])
    expect((await run(f.conversations.get(input.id)))?.origin).toEqual({
      kind: "whatsapp",
      sender: input.sender,
      messageId: input.messageId,
    })
    expect(await run(f.store.list())).toHaveLength(1)
    f.complete(input.id)
    await run(f.app.pump())
    await run(f.app.pump())
    expect(f.sends).toHaveLength(1)
    expect(f.sends[0]).toContain("Pasta tonight.")
    expect((await run(f.store.get(input.id)))?.state).toBe("sent")
  })
  it("rejects changed content for an already recorded provider message ID", async () => {
    const f = await fixture(),
      input = await incoming()
    await run(f.app.receive(input))
    await expect(
      run(f.app.receive({ ...input, fingerprint: "b".repeat(64) }))
    ).rejects.toThrow()
    expect(await run(f.store.list())).toHaveLength(1)
  })
  it("recovers a committed send intent as uncertain without resending", async () => {
    const f = await fixture(),
      input = await incoming()
    await run(f.app.receive(input))
    await run(f.app.pump())
    f.complete(input.id)
    const record = (await run(f.store.get(input.id)))!
    expect(
      await run(
        f.store.claim(record, "Prepared reply", () => Effect.succeed(true))
      )
    ).toBe(true)
    const restarted = new WhatsAppStore(f.db)
    await run(restarted.recover())
    await run(f.app.pump())
    expect((await run(restarted.get(input.id)))?.state).toBe("uncertain")
    expect(f.sends).toEqual([])
  })
  it("requires acknowledgement for an ambiguous send and replays the exact retry once", async () => {
    const f = await fixture(),
      input = await incoming()
    await run(f.app.receive(input))
    await run(f.app.pump())
    f.complete(input.id)
    f.fail(true)
    await run(f.app.pump())
    await run(f.app.pump())
    expect(f.sends).toHaveLength(1)
    await expect(
      run(
        f.store.retry(input.id, false, crypto.randomUUID(), Date.now() + 60_000)
      )
    ).rejects.toThrow()
    const operationId = crypto.randomUUID()
    await run(f.store.retry(input.id, true, operationId, Date.now() + 60_000))
    await run(f.store.retry(input.id, true, operationId, Date.now() + 60_000))
    f.clear()
    await run(f.app.pump())
    expect(f.sends).toHaveLength(2)
    expect((await run(f.store.get(input.id)))?.state).toBe("sent")
  })
  it.each(["disabled", "archived"])(
    "stops an unsent reply when %s",
    async (reason) => {
      const f = await fixture(),
        input = await incoming()
      await run(f.app.receive(input))
      await run(f.app.pump())
      f.complete(input.id)
      if (reason === "disabled")
        await run(
          f.app.configure(
            { operationId: crypto.randomUUID(), revision: 1, enabled: false },
            homeAgentId
          )
        )
      else f.profiles[0] = { ...f.profiles[0]!, status: "archived" }
      await run(f.app.pump())
      expect((await run(f.store.get(input.id)))?.state).toBe("cancelled")
      expect(f.sends).toEqual([])
    }
  )
  it("expires the reply window without inference or automatic sends after a new message", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const f = await fixture(),
      input = await incoming()
    await run(f.app.receive(input))
    // Keep work discovery live so this test isolates the provider's reply window.
    f.db.run(
      "UPDATE whatsapp_messages SET work_deadline=? WHERE id=?",
      Date.now() + WHATSAPP_WINDOW_MS + 60_000,
      input.id
    )
    vi.setSystemTime(Date.now() + WHATSAPP_WINDOW_MS)
    await run(f.app.pump())
    expect((await run(f.store.get(input.id)))?.state).toBe("expired")
    expect(f.admissions).toEqual([])
    await run(f.app.receive(await incoming("wamid.new")))
    await run(f.app.pump())
    expect(f.admissions.map((item) => item.id)).not.toContain(input.id)
    await run(
      f.store.retry(input.id, false, crypto.randomUUID(), Date.now() + 60_000)
    )
    await run(f.app.pump())
    expect(f.admissions.map((item) => item.id)).toContain(input.id)
  })
  it("pins earlier requests to their agent when a command changes the active route", async () => {
    const f = await fixture(),
      first = await incoming()
    await run(f.app.receive(first))
    await run(f.app.receive(await incoming("wamid.route", `/agent ${child}`)))
    const next = await incoming("wamid.next")
    await run(f.app.receive(next))
    await run(f.app.pump())
    expect(f.admissions).toContainEqual({ agent: homeAgentId, id: first.id })
    expect(f.admissions).toContainEqual({ agent: child, id: next.id })
    expect((await run(f.store.settings())).agentId).toBe(child)
  })
  it("creates one review notice while keeping approval authority in Pi", async () => {
    const f = await fixture(),
      input = await incoming()
    await run(f.app.receive(input))
    await run(f.app.pump())
    f.approve(true)
    await run(f.app.pump())
    await run(f.app.pump())
    await run(f.app.pump())
    expect(f.sends).toHaveLength(1)
    expect(f.sends[0]).toContain("WhatsApp messages cannot approve actions")
    expect((await run(f.store.get(input.id)))?.state).toBe("waiting")
    f.approve(false)
    f.complete(input.id)
    await run(f.app.pump())
    expect(f.sends).toHaveLength(2)
  })
  it("does not extend the service window on duplicate delivery and bounds the pending inbox", async () => {
    const f = await fixture(),
      input = await incoming()
    await run(f.app.receive(input))
    const before = (await run(f.store.settings())).lastInboundAt
    await run(f.app.receive(input))
    expect((await run(f.store.settings())).lastInboundAt).toBe(before)
    for (let i = 1; i < 20; i++)
      await run(f.app.receive(await incoming(`wamid.${i}`)))
    await expect(
      run(f.app.receive(await incoming("wamid.overflow")))
    ).rejects.toThrow()
    expect(await run(f.app.receive(input))).toBe(false)
    expect(await run(f.store.pending())).toHaveLength(20)
  })
})
