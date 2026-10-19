import { Effect } from "effect"
import { expect, it, vi } from "vitest"

import { homeAgentId } from "../src/agents/domain"
import { EmailStore } from "../src/email/adapters/sqlite"
import { EmailStorageError, type IncomingEmail } from "../src/email/contracts"
import { emailPump } from "../src/email/pump"
import { WhatsAppStore } from "../src/whatsapp/adapters/sqlite"
import { whatsappIdentity } from "../src/whatsapp/contracts"
import { whatsappPump } from "../src/whatsapp/pump"
import { database } from "./database"

const run = Effect.runPromise
const body = "STOP home/request/original-request"
const email: IncomingEmail = {
  id: crypto.randomUUID(),
  fingerprint: "a".repeat(64),
  messageId: "<task-control@example.com>",
  sender: "owner@example.com",
  recipient: "private@example.com",
  subject: "Stop the request",
  body,
  references: "",
  files: [],
}

it("email controls bypass a held conversation and checkpoint their reply before sending", async () => {
  const records = new EmailStore(database())
  await run(
    records.configure({
      enabled: true,
      revision: 0,
      operationId: crypto.randomUUID(),
    })
  )
  await run(records.receive(email, 1))
  const admit = vi.fn(() => Effect.void)
  const control = vi.fn(() =>
    Effect.succeed("Stop requested for original-request.")
  )
  const send = vi.fn(() => Effect.succeed("provider-receipt"))
  const host = {
    active: () => Effect.succeed(true),
    admit,
    turn: () => Effect.succeed(undefined),
    control,
    send,
    reviewUrl: () =>
      Effect.succeed("https://app.example/agents/personal-assistant"),
  }
  await run(emailPump(records, host)())
  expect(control).toHaveBeenCalledTimes(1)
  expect(admit).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
  // Recreate the adapter, as after a restart. Do not run the control again.
  await run(emailPump(records, host)())
  await run(emailPump(records, host)())
  expect(control).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledTimes(1)
  expect((await run(records.get(email.id)))?.state).toBe("sent")
})

it("a lost email checkpoint repeats only the exact original stop, never the newer task", async () => {
  const records = new EmailStore(database())
  await run(
    records.configure({
      enabled: true,
      revision: 0,
      operationId: crypto.randomUUID(),
    })
  )
  await run(records.receive(email, 1))
  const update = records.update.bind(records)
  let lose = true
  vi.spyOn(records, "update").mockImplementation((...args) => {
    if (lose && args[2] === "waiting") {
      lose = false
      return Effect.fail(
        new EmailStorageError({ operation: "lost checkpoint" })
      )
    }
    return update(...args)
  })
  const stopped: string[] = []
  const control = vi.fn((record: { body: string }) =>
    Effect.sync(() => {
      stopped.push(record.body)
      return "Stop requested."
    })
  )
  const pump = emailPump(records, {
    active: () => Effect.succeed(true),
    admit: () => Effect.die("must not admit control"),
    turn: () => Effect.succeed(undefined),
    control,
    send: () => Effect.succeed("receipt"),
    reviewUrl: () =>
      Effect.succeed("https://app.example/agents/personal-assistant"),
  })
  await expect(run(pump())).rejects.toHaveProperty("_tag", "EmailStorageError")
  await run(pump())
  await run(pump())
  expect(stopped).toEqual([body, body])
  expect((await run(records.get(email.id)))?.state).toBe("sent")
})

it("WhatsApp controls retain the original routed agent and survive adapter recreation", async () => {
  const records = new WhatsAppStore(database())
  await run(
    records.configure(
      { enabled: true, revision: 0, operationId: crypto.randomUUID() },
      homeAgentId
    )
  )
  const input = {
    ...(await whatsappIdentity("task-control-whatsapp")),
    messageId: "task-control-whatsapp",
    sender: "15550101010",
    threadId: "whatsapp:123456:15550101010",
    body: "/status all",
    timestamp: Date.now(),
  }
  await run(records.receive(input, homeAgentId))
  const control = vi.fn(() =>
    Effect.succeed("Personal assistant: original-request is running.")
  )
  const send = vi.fn(() => Effect.succeed("wamid.control"))
  const admit = vi.fn(() => Effect.void)
  const host = {
    active: () => Effect.succeed(true),
    admit,
    turn: () => Effect.succeed(undefined),
    name: () => Effect.succeed("Personal assistant"),
    reviewUrl: () => "https://app.example/agents/personal-assistant",
    control,
    send,
  }
  await run(whatsappPump(records, host)())
  expect(control).toHaveBeenCalledExactlyOnceWith("/status all", homeAgentId)
  expect((await run(records.get(input.id)))?.control).toBe(true)
  await run(whatsappPump(records, host)())
  await run(whatsappPump(records, host)())
  expect(admit).not.toHaveBeenCalled()
  expect(control).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledTimes(1)
})

it("attachment-bearing email remains ordinary conversation input even when its text says STATUS", async () => {
  const records = new EmailStore(database())
  await run(
    records.configure({
      enabled: true,
      revision: 0,
      operationId: crypto.randomUUID(),
    })
  )
  await run(
    records.receive(
      {
        ...email,
        body: "STATUS",
        files: ["00000000-0000-4000-8000-000000000001"],
      },
      1
    )
  )
  const admit = vi.fn(() => Effect.void),
    control = vi.fn(() => Effect.succeed("status"))
  await run(
    emailPump(records, {
      active: () => Effect.succeed(true),
      admit,
      control,
      turn: () => Effect.succeed(undefined),
      send: () => Effect.succeed("receipt"),
      reviewUrl: () => Effect.succeed("https://app.example"),
    })()
  )
  expect(admit).toHaveBeenCalledTimes(1)
  expect(control).not.toHaveBeenCalled()
})
