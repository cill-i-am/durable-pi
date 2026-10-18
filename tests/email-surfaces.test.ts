import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { AccessStore } from "../src/access/adapters/sqlite"
import { AccessGate } from "../src/access/gate"
import {
  emailApprovalProof,
  emailApprovalToken,
  emailApprovalProofs,
} from "../src/email/adapters/approval-proof"
import {
  emailAttachments,
  incomingEmailRequest,
} from "../src/email/adapters/attachments"
import { EmailStore } from "../src/email/adapters/sqlite"
import { renderReplyEmail } from "../src/email/adapters/template"
import { emailApprovals } from "../src/email/approval-flow"
import { emailApprovalNotice, emailDecision } from "../src/email/approvals"
import type { IncomingEmail } from "../src/email/contracts"
import { emailPump } from "../src/email/pump"
import { database } from "./database"
import { imageWorkspace } from "./image-fixture"

const run = Effect.runPromise
const secret = "synthetic-email-approval-secret-32-characters"
const incoming = (body = "Please help."): IncomingEmail => ({
  id: crypto.randomUUID(),
  fingerprint: "a".repeat(64),
  messageId: "<fixture@example.com>",
  sender: "owner@example.com",
  recipient: "private@agents.example.com",
  subject: "Email acceptance",
  body,
  references: "",
})
function approvalsFixture() {
  const db = database(),
    records = new EmailStore(db)
  const access = new AccessStore(db, () =>
    Effect.succeed([
      {
        name: "run_command",
        title: "Run a command",
        description: "Execute a command",
        mode: "ask",
      },
    ])
  )
  const gate = new AccessGate(access, () => Effect.succeed(true))
  const flow = emailApprovals(records, gate, {
    proofs: emailApprovalProofs(secret),
    active: () => Effect.succeed(true),
    wakeConversation: () => Effect.void,
    members: () => Effect.succeed([]),
  })
  const sent: string[] = []
  let admitted = 0
  const pump = emailPump(records, {
    active: () => Effect.succeed(true),
    admit: () =>
      Effect.sync(() => {
        admitted++
      }),
    turn: () => Effect.succeed(undefined),
    reviewUrl: () =>
      Effect.succeed("https://pi.example.com/agents/personal-assistant"),
    send: (_record, text) =>
      Effect.sync(() => {
        sent.push(text)
        return "provider-id"
      }),
    ...flow,
  })
  return { records, access, gate, flow, sent, pump, admissions: () => admitted }
}
describe("email approvals", () => {
  it("wakes a tool already waiting in the gate after the email transaction commits", async () => {
    const f = approvalsFixture(),
      root = incoming()
    let executed = 0
    const work = run(
      f.gate.run(
        {
          id: "waiting-operation",
          turnId: root.id,
          tool: "run_command",
          input: "{}",
        },
        Effect.sync(() => ++executed)
      )
    )
    const operation = (await run(f.gate.pending()))[0]!
    const command = incoming(
      `APPROVE ${emailApprovalToken(secret, root.recipient, operation)}`
    )
    await run(f.records.receive(command, 1))
    await run(f.flow.decide((await run(f.records.get(command.id)))!))
    expect(await work).toBe(1)
    expect(executed).toBe(1)
  }, 2000)
  it.each([true, false])(
    "notifies once, accepts an explicit decision (%s) and preserves the tool policy",
    async (approve) => {
      const f = approvalsFixture(),
        root = incoming()
      await run(f.records.receive(root, 1))
      const operation = await run(
        f.access.begin({
          id: "operation",
          turnId: root.id,
          tool: "run_command",
          input: '{"command":"printf acceptance","timeoutMs":1000}',
        })
      )
      await run(
        f.access.begin({
          id: "unrelated",
          turnId: "another-request",
          tool: "run_command",
          input: "{}",
        })
      )
      await run(f.pump())
      await run(f.pump())
      await run(f.pump())
      await run(f.pump())
      expect(f.sent).toHaveLength(1)
      expect(f.sent[0]).toContain("Command: printf acceptance")
      expect(f.sent[0]).not.toContain("unrelated")
      const token = emailApprovalToken(secret, root.recipient, operation)
      const reply = incoming(
        `${approve ? "APPROVE" : "DENY"} ${token}\n\n> Old quoted email`
      )
      await run(f.records.receive(reply, 1))
      await run(f.pump())
      await run(f.pump())
      expect((await run(f.access.get(operation.id)))?.status).toBe(
        approve ? "approved" : "denied"
      )
      expect((await run(f.access.policies()))[0]?.mode).toBe("ask")
      expect(f.admissions()).toBe(1)
      expect(f.sent).toHaveLength(2)
      if (approve) {
        expect(await run(f.access.claim(operation.id))).toBe("execute")
        await run(f.access.finish(operation.id, "result"))
        expect(await run(f.access.claim(operation.id))).toEqual({
          result: "result",
        })
      } else
        await expect(run(f.access.claim(operation.id))).rejects.toMatchObject({
          _tag: "AccessDenied",
        })
      await run(f.pump())
      expect(f.sent).toHaveLength(2)
    }
  )
  it("rejects cross-agent tokens, tampering, expiry and quoted commands", async () => {
    const f = approvalsFixture(),
      input = incoming()
    const operation = await run(
      f.access.begin({
        id: "operation",
        turnId: input.id,
        tool: "run_command",
        input: "{}",
      })
    )
    const token = emailApprovalToken(secret, input.recipient, operation)
    expect(
      emailApprovalProof(secret, input.recipient, token, operation.createdAt).id
    ).toBe(operation.id)
    expect(() =>
      emailApprovalProof(
        secret,
        "other@agents.example.com",
        token,
        operation.createdAt
      )
    ).toThrow()
    expect(() =>
      emailApprovalProof(
        secret,
        input.recipient,
        `x${token}`,
        operation.createdAt
      )
    ).toThrow()
    expect(() =>
      emailApprovalProof(secret, input.recipient, token, operation.expiresAt)
    ).toThrow()
    expect(emailDecision(`Thanks\n\nAPPROVE ${token}`)).toBeUndefined()
    expect(emailDecision(`> APPROVE ${token}`)).toBeUndefined()
    expect(emailDecision("yes")).toBeUndefined()
    expect(emailDecision(`APPROVE\n${token}\n\n> old card`)).toEqual({
      approve: true,
      token,
    })
    expect(emailDecision(`DENY\n${token}`)).toEqual({ approve: false, token })
    for (const quote of [
      `> ${token}`,
      `\n${token}`,
      `On Sunday, old mail\n${token}`,
    ])
      expect(emailDecision(`APPROVE\n${quote}`)?.token).toBe("")
    const reply = incoming(`APPROVE ${token}`)
    await run(f.records.receive(reply, 1))
    await run(
      f.records.configure({
        operationId: crypto.randomUUID(),
        revision: 0,
        enabled: false,
      })
    )
    await expect(
      run(f.flow.decide((await run(f.records.get(reply.id)))!))
    ).rejects.toMatchObject({ _tag: "EmailRejected" })
    expect((await run(f.access.get(operation.id)))?.status).toBe("pending")
  })
  it("renders readable escaped details and buttons that prepare an email decision", async () => {
    const f = approvalsFixture(),
      input = incoming()
    const operation = await run(
      f.access.begin({
        id: "operation",
        turnId: input.id,
        tool: "run_command",
        input: '{"command":"<script>private & untrusted</script>"}',
      })
    )
    const token = emailApprovalToken(secret, input.recipient, operation)
    await run(f.records.receive(input, 1))
    const record = (await run(f.records.get(input.id)))!
    const text =
      emailApprovalNotice(operation, token) +
      "\n\nView this agent in Pi: https://pi.example.com/agents/personal-assistant"
    const html = await renderReplyEmail(
      { ...record, purpose: "notification" },
      text
    )
    expect(html).toContain("Approve once")
    expect(html).toContain("mailto:private@agents.example.com?")
    expect(html).toContain("body=APPROVE+")
    expect(html).toContain("Command: &lt;script&gt;")
    expect(html).not.toContain("<script>")
    expect(html).toContain(
      'href="https://pi.example.com/agents/personal-assistant"'
    )
    const normal = await renderReplyEmail(record, text)
    expect(normal).not.toContain("mailto:")
  })
})
describe("email attachment transport", () => {
  it("imports binary MIME parts into the shared workspace and sends only selected reply files", async () => {
    const f = imageWorkspace(),
      input = { ...incoming(), files: [crypto.randomUUID()] }
    const data = new TextEncoder().encode("A private report 🐟")
    const form = new FormData()
    form.set("message", JSON.stringify(input))
    form.append(
      "attachment",
      new File([data], "report.txt", { type: "text/plain" })
    )
    const parsed = await run(
      incomingEmailRequest(
        new Request("https://agent.internal", { method: "POST", body: form })
      )
    )
    expect(parsed.input.files).toEqual(input.files)
    const file = await run(f.workspace.upload(parsed.attachments[0]!))
    expect((await run(f.workspace.attach([file.id]))).content[1]).toMatchObject(
      { type: "text", text: expect.stringContaining("A private report 🐟") }
    )
    expect(await run(emailAttachments(f.workspace, []))).toEqual([])
    await run(
      f.workspace.replyFile({
        operationId: "share-report",
        turnId: input.id,
        fileId: file.id,
      })
    )
    const reply = await run(
      emailAttachments(
        f.workspace,
        (await run(f.workspace.replyFiles(input.id))).map((file) => file.id)
      )
    )
    expect(reply).toHaveLength(1)
    expect(reply[0]).toMatchObject({
      filename: "report.txt",
      disposition: "attachment",
      content: data.buffer,
    })
    expect(
      await run(
        emailAttachments(
          f.workspace,
          (await run(f.workspace.replyFiles("other-turn"))).map(
            (file) => file.id
          )
        )
      )
    ).toEqual([])
  })
  it("enables new email settings by default and preserves explicit disable/revocation", async () => {
    const records = new EmailStore(database())
    expect(await run(records.settings())).toMatchObject({
      enabled: true,
      generation: 1,
    })
    await run(
      records.configure({
        operationId: crypto.randomUUID(),
        enabled: false,
        revision: 0,
      })
    )
    expect(await run(records.settings())).toMatchObject({ enabled: false })
    await expect(run(records.receive(incoming(), 1))).rejects.toMatchObject({
      _tag: "EmailRejected",
    })
    await run(
      records.configure({
        operationId: crypto.randomUUID(),
        enabled: true,
        revision: 1,
      })
    )
    expect(await run(records.settings())).toMatchObject({
      enabled: true,
      generation: 2,
    })
    await expect(run(records.receive(incoming(), 1))).rejects.toMatchObject({
      _tag: "EmailRejected",
    })
  })
})
