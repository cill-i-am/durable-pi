import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { homeAgentId } from "../src/agents/domain"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { EmailStore } from "../src/email/adapters/sqlite"
import { emailPump } from "../src/email/pump"
import { emailReply } from "../src/email/reply"
import {
  ReplySendFailed,
  splitReply,
  type ReplyPart,
} from "../src/replies/contracts"
import { WhatsAppStore } from "../src/whatsapp/adapters/sqlite"
import { whatsappIdentity } from "../src/whatsapp/contracts"
import { whatsappPump } from "../src/whatsapp/pump"
import { whatsappReply } from "../src/whatsapp/reply"
import { database } from "./database"

const run = Effect.runPromise
const answer = `\n  First line\n${"A complete paragraph 🐟\n".repeat(600)}LAST LINE\n`
const url = "https://pi.example.com/agents/personal-assistant"
const files = Array.from({ length: 4 }, () => ({
  id: crypto.randomUUID(),
  size: 8 * 1024 * 1024,
}))

async function fixture(channel: "email" | "whatsapp") {
  const db = database()
  const id = crypto.randomUUID()
  const sends: ReplyPart[] = []
  const state = { failureAt: 0, uncertain: false, revoke: false, answer, files }
  let enabled: (value: boolean) => Promise<unknown>
  const send = (part: ReplyPart) =>
    Effect.gen(function* () {
      sends.push(part)
      if (state.revoke && sends.length === 1) {
        yield* Effect.promise(async () => {
          await enabled(false)
          await enabled(true)
        })
      }
      if (state.failureAt === sends.length)
        return yield* new ReplySendFailed({ uncertain: state.uncertain })
      return `provider-${sends.length}`
    })
  const conversations = new ConversationStore(db, {
    model: "test",
    thinking: "medium",
  })
  const admitted = await run(
    conversations.admit({ operationId: id, text: "Reply please" })
  )
  if (channel === "email") {
    const store = new EmailStore(db)
    enabled = async (value) => {
      const current = await run(store.settings())
      return run(
        store.configure({
          operationId: crypto.randomUUID(),
          revision: current.revision,
          enabled: value,
        })
      )
    }
    const settings = await run(store.settings())
    await run(
      store.receive(
        {
          id,
          fingerprint: "a".repeat(64),
          messageId: "<fixture@example.com>",
          sender: "owner@example.com",
          recipient: "private@agents.example.com",
          subject: "Full reply",
          body: "Reply please",
          references: "",
        },
        settings.generation
      )
    )
    const pump = emailPump(store, {
      active: () => Effect.succeed(true),
      admit: () => Effect.void,
      turn: () =>
        Effect.succeed({
          ...admitted.turn,
          status: "done",
          answer: state.answer,
        }),
      files: () => Effect.succeed(state.files),
      reviewUrl: () => Effect.succeed(url),
      send: (_record, text, ids = []) => send({ text, files: [...ids] }),
    })
    await run(pump())
    return {
      sends,
      state,
      pump: () => run(pump()),
      read: () => run(store.get(id)),
      retry: (ack: boolean) => run(store.retry(id, ack, crypto.randomUUID())),
      recover: () => run(new EmailStore(db).recover()),
      forceSending: () => run(store.update(id, "sent", "sending")),
    }
  }
  const store = new WhatsAppStore(db)
  enabled = async (value) => {
    const current = await run(store.settings())
    return run(
      store.configure(
        {
          operationId: crypto.randomUUID(),
          revision: current.revision,
          enabled: value,
        },
        homeAgentId
      )
    )
  }
  await enabled(true)
  await run(
    store.receive(
      {
        id,
        fingerprint: (await whatsappIdentity(id)).fingerprint,
        messageId: "wamid.fixture",
        threadId: "whatsapp:123456:15550101010",
        sender: "15550101010",
        body: "Reply please",
        timestamp: Date.now(),
      },
      homeAgentId
    )
  )
  const pump = whatsappPump(store, {
    active: () => Effect.succeed(true),
    admit: () => Effect.void,
    turn: () =>
      Effect.succeed({
        status: "done",
        answer: state.answer,
        needsApproval: false,
        files: state.files.map((file) => file.id),
      }),
    name: () => Effect.succeed("Assistant"),
    reviewUrl: () => url,
    send: (record, text) =>
      send({
        text,
        files: record.outboundFileId ? [record.outboundFileId] : [],
      }),
  })
  await run(pump())
  return {
    sends,
    state,
    pump: () => run(pump()),
    read: () => run(store.get(id)),
    retry: (ack: boolean) => run(store.retry(id, ack, crypto.randomUUID())),
    recover: () => run(new WhatsAppStore(db).recover()),
    forceSending: () => run(store.update(id, "sent", "sending")),
  }
}

function originalText(
  channel: "email" | "whatsapp",
  parts: readonly ReplyPart[]
) {
  if (channel === "email")
    return parts[0]!.text.replace(`\n\nView this agent in Pi: ${url}`, "")
  return parts
    .filter((part) => !part.files.length)
    .map((part) =>
      part.text.replace(/^Assistant\n\n/, "").replace(`\n\n${url}`, "")
    )
    .join("")
}

describe.each(["email", "whatsapp"] as const)(
  "%s complete reply delivery",
  (channel) => {
    it("preserves the entire answer and every selected file, without replaying a completed reply", async () => {
      const f = await fixture(channel)
      await f.pump()
      const record = await f.read()
      expect(record?.state).toBe("sent")
      expect(originalText(channel, f.sends)).toBe(answer)
      expect(f.sends.flatMap((part) => part.files)).toEqual(
        files.map((file) => file.id)
      )
      expect(record?.delivery?.receipts).toHaveLength(f.sends.length)
      if (channel === "whatsapp")
        expect(
          f.sends.every(
            (part) => part.text.length <= 3900 && part.files.length <= 1
          )
        ).toBe(true)
      const count = f.sends.length
      await f.pump()
      expect(f.sends).toHaveLength(count)
    })

    it.each([false, true])(
      "retries only the remaining frozen parts after uncertain=%s",
      async (uncertain) => {
        const f = await fixture(channel)
        f.state.failureAt = 2
        f.state.uncertain = uncertain
        await f.pump()
        expect((await f.read())?.state).toBe(uncertain ? "uncertain" : "failed")
        expect((await f.read())?.delivery?.receipts).toEqual(["provider-1"])
        await f.pump()
        expect(f.sends).toHaveLength(2)
        if (uncertain) await expect(f.retry(false)).rejects.toThrow()
        f.state.answer = "Changed after the initial send"
        f.state.files = []
        f.state.failureAt = 0
        await f.retry(uncertain)
        await f.pump()
        const record = await f.read()
        expect(record?.state).toBe("sent")
        expect(record?.delivery?.parts[0]).toEqual(f.sends[0])
        expect(
          f.sends.slice(1).filter((part) => part.text === f.sends[0]!.text)
        ).toHaveLength(0)
        expect(originalText(channel, record!.delivery!.parts)).toBe(answer)
        expect(record?.delivery?.parts.flatMap((part) => part.files)).toEqual(
          files.map((file) => file.id)
        )
        expect(f.sends).toHaveLength(record!.delivery!.parts.length + 1)
      }
    )

    it("stops remaining parts across disable and re-enable, retaining the confirmed receipt", async () => {
      const f = await fixture(channel)
      f.state.revoke = true
      await f.pump()
      expect(f.sends).toHaveLength(1)
      expect((await f.read())?.state).toBe("cancelled")
      expect((await f.read())?.delivery?.receipts).toEqual(["provider-1"])
    })

    it("recovers a final committed checkpoint without another provider call", async () => {
      const f = await fixture(channel)
      await f.pump()
      const count = f.sends.length
      await f.forceSending()
      await f.recover()
      expect((await f.read())?.state).toBe("sent")
      await f.pump()
      expect(f.sends).toHaveLength(count)
    })
  }
)

describe("provider reply planning", () => {
  it("splits Unicode without dropping any character or splitting a surrogate pair", () => {
    const text = "A🐟B🧭C".repeat(20)
    const parts = splitReply(text, 4)
    expect(parts.join("")).toBe(text)
    expect(
      parts.every(
        (part) =>
          part.length <= 4 &&
          !/[\uD800-\uDBFF]$/.test(part) &&
          !/^[\uDC00-\uDFFF]/.test(part)
      )
    ).toBe(true)
  })
  it("batches email files instead of replacing them with web links", () => {
    const parts = emailReply(answer, url, files)
    expect(parts).toHaveLength(2)
    expect(parts.flatMap((part) => part.files)).toEqual(
      files.map((file) => file.id)
    )
  })
  it("keeps WhatsApp file sends caption-free, including voice and documents", () => {
    const parts = whatsappReply(
      "Here are your files.",
      "Assistant",
      url,
      files.map((file) => file.id)
    )
    expect(
      parts
        .filter((part) => part.files.length)
        .every((part) => part.text === "")
    ).toBe(true)
  })
})
