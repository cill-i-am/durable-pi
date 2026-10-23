import { Effect } from "effect"
import { expect, it, vi } from "vitest"

import { homeAgentId, originalAgent } from "../src/agents/domain"
import { SqliteBackgroundMailbox } from "../src/delegation/adapters/background-mailbox"
import { makeBackgroundMailbox } from "../src/delegation/background-mailbox"
import { makeBackgroundDelegation } from "../src/delegation/background-service"
import { resolveRoute } from "../src/inference/policy"
import { localTaskControls } from "../src/tasks/adapters/personal-agent"
import { taskDirectory } from "../src/tasks/directory"
import { database } from "./database"

function fixture() {
  const db = database()
  const mailbox = makeBackgroundMailbox(
    new SqliteBackgroundMailbox(db),
    () => Effect.succeed("active"),
    "owner",
    () => crypto.randomUUID()
  )
  const row = Effect.runSync(
    mailbox.create(
      {
        objective: "Draft privately",
        tasks: [{ name: "Draft", task: "No outside action", tools: [] }],
      },
      {
        taskId: 19,
        turnId: "parent",
        conversationId: 1,
        memory: "",
        route: resolveRoute("conversation"),
      },
      Date.now() + 60_000
    )
  )
  const start = vi.fn(() => Effect.die("Cleanup must not resume execution"))
  const app = makeBackgroundDelegation(
    mailbox,
    {
      start,
      read: start,
      stop: () => Effect.void,
      control: () => Effect.succeed({ accepted: true }),
      transcript: () => Effect.succeed({ entries: [], cursor: null }),
    },
    {
      active: () => Effect.succeed(false),
      backgroundActive: () => Effect.succeed(false),
      wakeConversation: () => Effect.void,
      armBackground: () => Effect.void,
      wakeBackground: () => Effect.void,
      notify: () => Effect.void,
      admission: {
        transactionGroup: db,
        admit: (handoff) => Effect.succeed(handoff.reportId),
        stop: () => Effect.void,
      },
    }
  )
  const stop = vi.fn((id: number) => app.stop(id))
  const owner = {
    access: { state: () => Effect.succeed({ approvals: [] }) },
    conversations: { unfinished: () => Effect.succeed([]) },
    delegationLedger: { catalog: () => Effect.succeed([]) },
    communication: {
      runtime: { runSync: () => ({}) },
      mailbox: { pending: () => Effect.succeed([]) },
    },
    backgroundMailbox: mailbox,
    background: { stop },
  } as unknown as Parameters<typeof localTaskControls>[0]
  const local = localTaskControls(owner)
  const directory = taskDirectory({
    profiles: async () => [originalAgent("today")],
    list: () => Effect.runPromise(local.list()),
    stop: (_agent, ref) => Effect.runPromise(local.stop(ref)),
  })
  return { mailbox, row, start, stop, local, directory }
}

it.each(["pending", "unconfirmed"] as const)(
  "lists %s background cleanup and sends the same stable STOP handle to the owning domain",
  async (state) => {
    const f = fixture()
    Effect.runSync(f.mailbox.cancel(19, undefined, Date.now() + 60_000))
    if (state === "unconfirmed")
      Effect.runSync(f.mailbox.exhaustRecovery(() => true))
    expect(await Effect.runPromise(f.local.list())).toMatchObject([
      {
        id: "19",
        kind: "background",
        terminal: false,
        state: state === "pending" ? "stopping" : "stop-unconfirmed",
      },
    ])
    const status = await f.directory({ action: "status" }, homeAgentId)
    expect(status).toContain("home/background/19")
    const stopped = await f.directory(
      { action: "stop", handle: "home/background/19" },
      homeAgentId
    )
    expect(f.stop).toHaveBeenCalledExactlyOnceWith(19)
    expect(stopped).toContain("Current state: cancelled.")
    expect(await Effect.runPromise(f.local.list())).toEqual([])
    expect(Effect.runSync(f.mailbox.get(19))).toMatchObject({
      status: "cancelled",
      stop_state: "confirmed",
      handoff: f.row.handoff,
    })
    expect(Effect.runSync(f.mailbox.authorized(19))).toBe(false)
    expect(f.start).not.toHaveBeenCalled()
    await Effect.runPromise(f.local.stop({ kind: "background", id: "19" }))
    expect(f.stop).toHaveBeenCalledTimes(1)
  }
)
