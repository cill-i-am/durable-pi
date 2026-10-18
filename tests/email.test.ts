import { Effect, Exit } from "effect"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import { homeAgentId, AgentId } from "../src/agents/domain"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import type { Submission } from "../src/conversations/turns"
import {
  emailAddress,
  emailAgent,
  sameAddress,
} from "../src/email/adapters/address"
import {
  parseEmail,
  receiveCloudflareEmail,
} from "../src/email/adapters/incoming"
import { sendEmailReply } from "../src/email/adapters/sending"
import { EmailStore } from "../src/email/adapters/sqlite"
import {
  EmailUnavailable,
  EMAIL_MAX_RAW,
  type IncomingEmail,
} from "../src/email/contracts"
import { emailPump, EmailSendFailed } from "../src/email/pump"
import { database } from "./database"
import { run } from "./routine-fixture"

const secret = "email-fixture-secret-32-characters-long"
const owner = "owner@example.com",
  domain = "agents.example.com"
function mail(
  body = "Please help with dinner.",
  headers: Record<string, string | undefined> = {}
) {
  const fields = new Headers({
    From: owner,
    To: "home@agents.example.com",
    Subject: "Dinner",
    "Message-ID": "<dinner@example.com>",
    "Content-Type": "text/plain; charset=utf-8",
  })
  for (const [name, value] of Object.entries(headers))
    if (value !== undefined) fields.set(name, value)
  const raw =
    [...fields].map(([name, value]) => `${name}: ${value}`).join("\r\n") +
    "\r\n\r\n" +
    body
  const bytes = new TextEncoder().encode(raw)
  return {
    from: owner,
    to: "home@agents.example.com",
    headers: fields,
    rawSize: bytes.length,
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
  }
}
function fixture() {
  const db = database(),
    records = new EmailStore(db)
  const conversations = new ConversationStore(db, {
    model: "test",
    thinking: "medium",
  })
  run(
    records.configure({
      operationId: crypto.randomUUID(),
      revision: 0,
      enabled: true,
    })
  )
  let connected = true,
    active = true,
    sends = 0,
    admissions = 0
  let sendError: EmailSendFailed | undefined
  const pump = emailPump(records, {
    active: () => Effect.sync(() => active),
    admit: (input: Submission) =>
      Effect.suspend(() => {
        if (!connected) return Effect.fail(new EmailUnavailable())
        admissions++
        return conversations
          .admit(input)
          .pipe(Effect.mapError(() => new EmailUnavailable()))
      }),
    turn: (id) => conversations.get(id).pipe(Effect.orDie),
    send: (_record, _reply) =>
      Effect.suspend(() => {
        sends++
        return sendError
          ? Effect.fail(sendError)
          : Effect.succeed("<provider@example.com>")
      }),
    reviewUrl: () =>
      Effect.succeed("https://pi.example.com/agents/personal-assistant"),
  })
  const input: IncomingEmail = {
    id: crypto.randomUUID(),
    fingerprint: "a".repeat(64),
    messageId: "<dinner@example.com>",
    sender: owner,
    recipient: "private@agents.example.com",
    subject: "Dinner",
    body: "Help with dinner.",
    references: "",
  }
  const complete = () =>
    db.run(
      "UPDATE chat_turns SET status='done',answer='Pasta tonight.' WHERE id=?",
      input.id
    )
  return {
    db,
    records,
    conversations,
    input,
    pump,
    complete,
    sends: () => sends,
    admissions: () => admissions,
    connected: (value: boolean) => {
      connected = value
    },
    active: (value: boolean) => {
      active = value
    },
    fail: (uncertain: boolean) => {
      sendError = new EmailSendFailed({ uncertain })
    },
  }
}
describe("private agent email addresses", () => {
  it("binds addresses to owner, agent, domain and revocation generation", async () => {
    const agent = Schema.decodeUnknownSync(AgentId)(
      "12345678-1234-4234-a234-123456789abc"
    )
    const address = await emailAddress(secret, domain, "owner-id", agent, 1)
    expect(address.split("@")[0]!.length).toBeLessThanOrEqual(64)
    expect(address).toMatch(/^pi\+[a-f0-9]{32}\.[a-z2-7]{26}@/)
    expect(address.split("+")[0]).toBe("pi")
    expect(emailAgent(address, domain)).toBe(agent)
    expect(sameAddress(address, address)).toBe(true)
    for (const other of [
      await emailAddress(secret, domain, "different-owner", agent, 1),
      await emailAddress(secret, domain, "owner-id", agent, 2),
      await emailAddress(secret, domain, "owner-id", homeAgentId, 1),
    ])
      expect(sameAddress(other, address)).toBe(false)
    expect(emailAgent(address, "other.example.com")).toBeUndefined()
  })
})
describe("inbound MIME boundary", () => {
  it("extracts text, threads, and a stable receipt; content changes keep identity but conflict", async () => {
    const original = await parseEmail(mail(), owner)
    expect(original.body).toBe("Please help with dinner.")
    expect(original.messageId).toBe("<dinner@example.com>")
    expect(await parseEmail(mail(), owner)).toEqual(original)
    const changed = await parseEmail(mail("A different instruction."), owner)
    expect(changed.id).toBe(original.id)
    expect(changed.fingerprint).not.toBe(original.fingerprint)
  })
  it("uses a stable content identity when Message-ID is missing", async () => {
    const first = mail()
    first.headers.delete("Message-ID")
    const a = await parseEmail(mail("hello", { "Message-ID": "" }), owner)
    const b = await parseEmail(mail("hello", { "Message-ID": "" }), owner)
    expect(a.id).toBe(b.id)
  })
  it("accepts a first-line decision with a long quoted card without admitting the quote", async () => {
    const result = await parseEmail(
      mail(
        `APPROVE synthetic.proof\n\n> ${"Quoted action details. ".repeat(2000)}`
      ),
      owner
    )
    expect(result.body).toBe("APPROVE synthetic.proof")
    const changedQuote = await parseEmail(
      mail("APPROVE synthetic.proof\n\n> Changed quoted details."),
      owner
    )
    expect(changedQuote.id).toBe(result.id)
    expect(changedQuote.fingerprint).not.toBe(result.fingerprint)
    await expect(
      parseEmail(
        mail(`Thanks\n\n> APPROVE synthetic.proof\n${"x".repeat(25000)}`),
        owner
      )
    ).rejects.toMatchObject({ _tag: "EmailRejected" })
  })
  it("extracts HTML text without executing or retaining scripts", async () => {
    const result = await parseEmail(
      mail("<p>Hello &amp; welcome</p><script>steal()</script>", {
        "Content-Type": "text/html",
      }),
      owner
    )
    expect(result.body).toBe("Hello & welcome")
  })
  it("handles deeply nested HTML within the MIME size limit", async () => {
    const result = await parseEmail(
      mail(`${"<div>".repeat(4000)}Hello${"</div>".repeat(4000)}`, {
        "Content-Type": "text/html",
      }),
      owner
    )
    expect(result.body).toBe("Hello")
  })
  it.each([
    { from: "intruder@example.com" },
    { header: { From: "intruder@example.com" } },
    { header: { "Auto-Submitted": "auto-replied" } },
    { header: { "List-ID": "list.example.com" } },
    { body: "" },
  ])("rejects unauthorised senders and loop traffic: %j", async (input) => {
    const message = mail(input.body ?? "hello", input.header)
    if (input.from) message.from = input.from
    await expect(parseEmail(message, owner)).rejects.toMatchObject({
      _tag: "EmailRejected",
    })
  })
  it("preserves attachment bytes and stable file identities", async () => {
    const message = mail(
      '--boundary\r\nContent-Type: text/plain\r\n\r\nhello\r\n--boundary\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="file.pdf"\r\n\r\npdf\r\n--boundary--',
      { "Content-Type": 'multipart/mixed; boundary="boundary"' }
    )
    const parsed = await parseEmail(message, owner)
    expect(parsed.attachments).toMatchObject([
      {
        name: "file.pdf",
        mime: "application/pdf",
        bytes: new TextEncoder().encode("pdf"),
      },
    ])
    expect(parsed.files).toEqual(parsed.attachments.map((file) => file.id))
  })
  it("enforces actual stream size even when rawSize lies", async () => {
    const message = mail("x".repeat(EMAIL_MAX_RAW + 1))
    message.rawSize = 1
    await expect(parseEmail(message, owner)).rejects.toMatchObject({
      _tag: "EmailRejected",
    })
  })
  it("permanently rejects invalid addresses but propagates transient admission failures", async () => {
    let rejection = "",
      delivered = false
    const input = mail()
    const message = {
      ...input,
      setReject: (value: string) => {
        rejection = value
      },
      forward: async () => ({ messageId: "fixture" }),
      reply: async () => ({ messageId: "fixture" }),
    }
    await receiveCloudflareEmail(message, {
      domain,
      ownerEmail: owner,
      deliver: async () => {
        delivered = true
      },
    })
    expect(rejection).toContain("Unknown")
    expect(delivered).toBe(false)
    message.to = await emailAddress(secret, domain, "owner-id", homeAgentId, 1)
    await expect(
      receiveCloudflareEmail(message, {
        domain,
        ownerEmail: owner,
        deliver: async () => {
          throw new Error("temporary")
        },
      })
    ).rejects.toThrow("temporary")
  })
})
describe("durable receipt and reply delivery", () => {
  it("deduplicates before admission and rejects an identity reused for changed content", async () => {
    const f = fixture()
    expect(run(f.records.receive(f.input, 1))).toBe(true)
    expect(run(f.records.receive(f.input, 1))).toBe(false)
    expect(() =>
      run(f.records.receive({ ...f.input, fingerprint: "b".repeat(64) }, 1))
    ).toThrow()
    await Effect.runPromise(f.pump())
    expect(f.admissions()).toBe(1)
    expect(run(f.conversations.get(f.input.id))?.origin).toEqual({
      kind: "email",
      sender: owner,
      subject: "Dinner",
    })
    await Effect.runPromise(f.pump())
    expect(f.admissions()).toBe(1)
  })
  it("replays lost admission acknowledgement with the same operation ID", async () => {
    const f = fixture()
    run(f.records.receive(f.input, 1))
    run(
      f.conversations.admit({
        operationId: f.input.id,
        text: "Subject: Dinner\n\nHelp with dinner.",
        mode: "followUp",
        origin: { kind: "email", sender: owner, subject: "Dinner" },
      })
    )
    await Effect.runPromise(f.pump())
    expect(run(f.conversations.recent())).toHaveLength(1)
  })
  it("retains emails while the model is disconnected and sends the committed answer once", async () => {
    const f = fixture()
    run(f.records.receive(f.input, 1))
    f.connected(false)
    expect(await Effect.runPromise(f.pump())).toBeGreaterThan(Date.now())
    expect(run(f.records.get(f.input.id))?.state).toBe("queued")
    f.connected(true)
    await Effect.runPromise(f.pump())
    f.complete()
    await Effect.runPromise(f.pump())
    await Effect.runPromise(f.pump())
    expect(f.sends()).toBe(1)
    const saved = run(f.records.get(f.input.id))
    expect(saved?.state).toBe("sent")
    expect(saved?.reply).toContain("Pasta tonight.")
    expect(saved?.providerId).toBe("<provider@example.com>")
  })
  it("does not resend a provider call interrupted before its result was committed", async () => {
    const f = fixture()
    run(f.records.receive(f.input, 1))
    await Effect.runPromise(f.pump())
    f.complete()
    run(f.records.update(f.input.id, "waiting", "sending"))
    const reopened = new EmailStore(f.db)
    run(reopened.recover())
    expect(run(reopened.get(f.input.id))?.state).toBe("uncertain")
    await Effect.runPromise(f.pump())
    expect(f.sends()).toBe(0)
    expect(run(reopened.receive(f.input, 1))).toBe(false)
  })
  it.each([false, true])(
    "persists a rejected or uncertain send without automatic replay (uncertain=%s)",
    async (uncertain) => {
      const f = fixture()
      run(f.records.receive(f.input, 1))
      await Effect.runPromise(f.pump())
      f.complete()
      f.fail(uncertain)
      await Effect.runPromise(f.pump())
      await Effect.runPromise(f.pump())
      expect(f.sends()).toBe(1)
      expect(run(f.records.get(f.input.id))?.state).toBe(
        uncertain ? "uncertain" : "failed"
      )
      if (uncertain)
        expect(() =>
          run(f.records.retry(f.input.id, false, crypto.randomUUID()))
        ).toThrow()
      const operation = crypto.randomUUID()
      run(f.records.retry(f.input.id, true, operation))
      run(f.records.retry(f.input.id, true, operation))
      expect(run(f.records.get(f.input.id))?.state).toBe("waiting")
    }
  )
  it("revokes the address generation and cancels unsent replies on disable", () => {
    const f = fixture()
    run(f.records.receive(f.input, 1))
    const disable = {
      operationId: crypto.randomUUID(),
      enabled: false,
      revision: 1,
    }
    run(f.records.configure(disable))
    run(f.records.configure(disable))
    expect(run(f.records.get(f.input.id))?.state).toBe("cancelled")
    run(
      f.records.configure({
        operationId: crypto.randomUUID(),
        enabled: true,
        revision: 2,
      })
    )
    expect(run(f.records.settings()).generation).toBe(2)
    expect(() =>
      run(f.records.receive({ ...f.input, id: crypto.randomUUID() }, 1))
    ).toThrow()
  })
  it("remembers older retry receipts after another tab retries and the reply fails again", async () => {
    const f = fixture()
    run(f.records.receive(f.input, 1))
    await Effect.runPromise(f.pump())
    f.complete()
    f.fail(true)
    await Effect.runPromise(f.pump())
    const first = crypto.randomUUID(),
      second = crypto.randomUUID()
    run(f.records.retry(f.input.id, true, first))
    await Effect.runPromise(f.pump())
    run(f.records.retry(f.input.id, true, second))
    await Effect.runPromise(f.pump())
    expect(f.sends()).toBe(3)
    run(f.records.retry(f.input.id, true, first))
    await Effect.runPromise(f.pump())
    expect(f.sends()).toBe(3)
    expect(run(f.records.get(f.input.id))?.state).toBe("uncertain")
    expect(() => run(f.records.retry(f.input.id, false, first))).toThrow()
    expect(() =>
      run(f.records.retry(crypto.randomUUID(), true, first))
    ).toThrow()
  })
  it("checks authority again when claiming a completed reply", async () => {
    const f = fixture()
    run(f.records.receive(f.input, 1))
    await Effect.runPromise(f.pump())
    f.complete()
    expect(
      run(f.records.claim(f.input.id, "answer", () => Effect.succeed(false)))
    ).toBe(false)
    expect(run(f.records.get(f.input.id))?.state).toBe("cancelled")
    await Effect.runPromise(f.pump())
    expect(f.sends()).toBe(0)
  })
  it("bounds retries while retaining their replay receipts", async () => {
    const f = fixture()
    run(f.records.receive(f.input, 1))
    await Effect.runPromise(f.pump())
    run(f.records.update(f.input.id, "waiting", "failed"))
    const first = crypto.randomUUID()
    for (let n = 0; n < 100; n++) {
      run(
        f.records.retry(
          f.input.id,
          false,
          n === 0 ? first : crypto.randomUUID()
        )
      )
      run(f.records.update(f.input.id, "waiting", "failed"))
    }
    expect(() =>
      run(f.records.retry(f.input.id, false, crypto.randomUUID()))
    ).toThrow()
    run(f.records.retry(f.input.id, false, first))
    expect(run(f.records.get(f.input.id))?.state).toBe("failed")
  })
  it("refuses delivery after archival", async () => {
    const f = fixture()
    run(f.records.receive(f.input, 1))
    await Effect.runPromise(f.pump())
    f.complete()
    f.active(false)
    await Effect.runPromise(f.pump())
    expect(f.sends()).toBe(0)
    expect(run(f.records.get(f.input.id))?.state).toBe("cancelled")
  })
  it("enforces the pending inbox bound without discarding existing receipts", () => {
    const f = fixture()
    for (let n = 0; n < 20; n++)
      run(f.records.receive({ ...f.input, id: crypto.randomUUID() }, 1))
    const exit = Effect.runSyncExit(f.records.receive(f.input, 1))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(run(f.records.pending())).toHaveLength(20)
  })
})
describe("provider binding", () => {
  it("builds threaded replies and escapes HTML", async () => {
    const f = fixture()
    run(f.records.receive(f.input, 1))
    const messages: EmailMessageBuilder[] = []
    const send = async (
      message: EmailMessage | EmailMessageBuilder
    ): Promise<EmailSendResult> => {
      messages.push(message as EmailMessageBuilder)
      return { messageId: "id" }
    }
    await Effect.runPromise(
      sendEmailReply(
        { send },
        run(f.records.get(f.input.id))!,
        "<script>hello & goodbye</script>"
      )
    )
    expect(messages[0]).toMatchObject({
      to: owner,
      from: f.input.recipient,
      replyTo: f.input.recipient,
      headers: {
        "In-Reply-To": f.input.messageId,
        References: f.input.messageId,
        "Auto-Submitted": "auto-replied",
      },
    })
    expect(messages[0]?.html).toContain("&lt;script&gt;")
  })
  it.each([
    { error: { code: "E_SENDER_NOT_VERIFIED" }, uncertain: false },
    { error: new Error("connection lost"), uncertain: true },
  ])(
    "classifies provider failure without guessing delivery: $uncertain",
    async ({ error, uncertain }) => {
      const f = fixture()
      run(f.records.receive(f.input, 1))
      const result = await Effect.runPromiseExit(
        sendEmailReply(
          {
            send: async () => {
              throw error
            },
          },
          run(f.records.get(f.input.id))!,
          "hello"
        )
      )
      expect(Exit.isFailure(result) && result.cause.reasons[0]).toMatchObject({
        _tag: "Fail",
        error: { _tag: "EmailSendFailed", uncertain },
      })
    }
  )
})
