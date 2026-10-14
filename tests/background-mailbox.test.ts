import type { EntryId, ConversationId } from "@earendil-works/pi-durable"
import { expect, it } from "vitest"
import { BackgroundMailbox } from "../src/delegation/adapters/background-mailbox"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { database } from "./database"
import { resolveRoute } from "../src/inference/policy"
import { archiveEntries } from "../src/conversations/adapters/pi-reply"
import type { Group } from "../src/delegation/contracts"

const route = {
  ...resolveRoute("conversation", { model: "gpt-6-luna", thinking: "low" }),
  contextWindow: 8192,
}
const brief = {
  objective: "Compare drafts",
  tasks: [
    { name: "Draft", task: "Draft privately, no outside actions", tools: [] },
  ],
}
function fixture() {
  const db = database(),
    conversations = new ConversationStore(db, route)
  let status: "active" | "done" | "cancelled" = "active",
    time = 1000
  const authority = () => status,
    now = () => time
  const mailbox = new BackgroundMailbox(db, authority, now)
  const source = {
    turnId: crypto.randomUUID(),
    conversationId: 1,
    taskId: 19,
    route,
    memory: "Owner reference",
  }
  const handoff = mailbox.create(brief, source, "owner-bot").handoff
  const result: Group = {
    id: 19,
    turnId: source.turnId,
    conversationId: 1,
    objective: brief.objective,
    route,
    createdAt: time,
    deadline: handoff.deadline,
    status: "completed",
    children: [
      {
        ...brief.tasks[0]!,
        id: 2,
        status: "completed",
        requests: 1,
        answer: "Draft only; uncertain figures.",
        inputTokens: 123,
        outputTokens: 45,
        steering: [],
        error: null,
      },
    ],
  }
  return {
    db,
    mailbox,
    conversations,
    source,
    handoff,
    result,
    reopen: () => new BackgroundMailbox(db, authority, now),
    status: (value: typeof status) => {
      status = value
    },
    advance: (ms: number) => {
      time += ms
    },
    admit: (h: typeof handoff, text: string) =>
      conversations.admit(
        {
          operationId: h.reportId,
          text,
          origin: { kind: "background", groupId: h.id, turnId: h.turnId },
        },
        undefined,
        [],
        h.route
      ),
  }
}

it("persists handoff and admits its report once with the original model and event provenance", () => {
  const f = fixture()
  expect(f.reopen().create(brief, f.source, "owner-bot").handoff).toEqual(
    f.handoff
  )
  expect(() =>
    f.mailbox.create({ ...brief, objective: "Changed" }, f.source, "owner-bot")
  ).toThrow("different request")
  f.mailbox.observed(19, f.result)
  expect(f.mailbox.deliver(f.admit)).toBe(false)
  f.status("done")
  f.conversations.setSettings({ model: "gpt-6-astra", thinking: "high" })
  expect(f.reopen().deliver(f.admit)).toBe(true)
  expect(f.reopen().deliver(f.admit)).toBe(false)
  const turns = f.conversations.recent()
  expect(turns).toHaveLength(1)
  expect(turns[0]!.routing).toEqual(route)
  expect(turns[0]!.origin).toEqual({
    kind: "background",
    groupId: 19,
    turnId: f.source.turnId,
  })
  expect(f.mailbox.authorized(19)).toBe(false)
})

it("rolls back report acknowledgement and conversation admission together", () => {
  const f = fixture()
  f.status("done")
  f.mailbox.observed(19, f.result)
  expect(() =>
    f.mailbox.deliver((h, text) => {
      f.admit(h, text)
      throw new Error("crash")
    })
  ).toThrow("crash")
  expect(f.conversations.recent()).toHaveLength(0)
  expect(f.mailbox.get(19)!.status).toBe("ready")
  expect(f.reopen().deliver(f.admit)).toBe(true)
})

it("repeated report retries preserve trusted provenance and archive as events", () => {
  const f = fixture()
  f.status("done")
  f.mailbox.observed(19, f.result)
  f.mailbox.deliver(f.admit)
  let turn = f.conversations.get(f.handoff.reportId)!
  for (let n = 0; n < 2; n++) {
    f.conversations.finish(
      turn,
      [{ id: turn.id, delivery: "unanswered" }],
      "",
      "Interrupted"
    )
    turn = f.conversations.admit({
      operationId: crypto.randomUUID(),
      text: turn.text,
      retryOf: turn.id,
    }).turn
    expect(turn.origin).toEqual({
      kind: "background",
      groupId: 19,
      turnId: f.source.turnId,
    })
    const archived = archiveEntries(
      turn,
      [
        {
          id: 1 as EntryId,
          conversationId: 1 as ConversationId,
          kind: "pi.user",
          data: {},
          model: [{ role: "user", content: turn.text, timestamp: 0 }],
        },
      ],
      new Map([[1, turn]])
    )
    expect(archived).toMatchObject([
      { source: `event:${turn.id}`, kind: "note" },
    ])
  }
})

it.each(["parent", "owner", "deadline"])(
  "%s cancellation fences provider access and pending delivery",
  (kind) => {
    const f = fixture()
    if (kind === "parent") f.status("cancelled")
    if (kind === "owner") f.mailbox.cancel(19)
    if (kind === "deadline") f.advance(600000)
    f.mailbox.reconcileCancellation()
    f.mailbox.observed(19, f.result)
    f.status("done")
    expect(f.mailbox.authorized(19)).toBe(false)
    expect(f.mailbox.deliver(f.admit)).toBe(false)
    expect(f.mailbox.get(19)!.status).toBe("cancelled")
  }
)

it("bounds transport retries, retains a deadline wake, and reuses explicit retry identity", () => {
  const f = fixture()
  for (let n = 0; n < 5; n++) f.mailbox.failed(19)
  expect(f.mailbox.get(19)!.status).toBe("paused")
  expect(f.mailbox.due()).toHaveLength(0)
  expect(f.mailbox.nextWake()).toBe(f.handoff.deadline)
  const id = crypto.randomUUID()
  expect(f.reopen().retry(19, id)).toBe(true)
  expect(f.reopen().retry(19, id)).toBe(false)
  expect(f.mailbox.get(19)!.handoff.reportId).toBe(f.handoff.reportId)
})

it("does not admit a result whose RPC acknowledgement arrives after the deadline", () => {
  const f = fixture()
  f.status("done")
  expect(f.mailbox.due()).toHaveLength(1)
  f.advance(600001)
  f.mailbox.observed(19, f.result)
  expect(f.mailbox.get(19)!.status).toBe("cancelled")
  expect(f.mailbox.deliver(f.admit)).toBe(false)
})

it("isolates bots, validates report ownership and limits unfinished groups", () => {
  const f = fixture(),
    other = new BackgroundMailbox(database(), () => "done")
  expect(other.get(19)).toBeUndefined()
  expect(other.authorized(19)).toBe(false)
  expect(() =>
    f.mailbox.observed(19, { ...f.result, turnId: "foreign" })
  ).toThrow("ownership")
  f.mailbox.create(
    brief,
    { ...f.source, taskId: 20, turnId: crypto.randomUUID() },
    "owner-bot"
  )
  expect(() =>
    f.mailbox.create(
      brief,
      { ...f.source, taskId: 21, turnId: crypto.randomUUID() },
      "owner-bot"
    )
  ).toThrow("two unfinished")
})
