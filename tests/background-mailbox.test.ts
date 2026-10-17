import type { EntryId, ConversationId } from "@earendil-works/pi-durable"
import { it as effectIt } from "@effect/vitest"
import { Cause, Context, Effect, Exit } from "effect"
import { TestClock } from "effect/testing"
import { expect, it } from "vitest"

import { archiveEntries } from "../src/conversations/adapters/pi-reply"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { ConversationFull } from "../src/conversations/turns"
import { backgroundRequest } from "../src/delegation/adapters/background-http"
import { SqliteBackgroundMailbox } from "../src/delegation/adapters/background-mailbox"
import { backgroundNative } from "../src/delegation/adapters/interop"
import { makeBackgroundMailbox } from "../src/delegation/background-mailbox"
import {
  makeBackgroundDelegation,
  type BackgroundRemote,
  type BackgroundHost,
} from "../src/delegation/background-service"
import { DelegationFailure, type Group } from "../src/delegation/contracts"
import { resolveRoute } from "../src/inference/policy"
import { database, corrupt } from "./database"

function gate<T>() {
  let release!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    release = done
    reject = fail
  })
  return { promise, release, reject }
}

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
  const authority = () => Effect.sync(() => status),
    now = () => time
  const mailbox = makeBackgroundMailbox(
    new SqliteBackgroundMailbox(db),
    authority,
    "owner-bot",
    () => crypto.randomUUID(),
    Effect.sync(now)
  )
  const source = {
    turnId: crypto.randomUUID(),
    conversationId: 1,
    taskId: 19,
    route,
    memory: "Owner reference",
  }
  const handoff = Effect.runSync(mailbox.create(brief, source)).handoff
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
    reopen: () =>
      makeBackgroundMailbox(
        new SqliteBackgroundMailbox(db),
        authority,
        "owner-bot",
        () => crypto.randomUUID(),
        Effect.sync(now)
      ),
    status: (value: typeof status) => {
      status = value
    },
    advance: (ms: number) => {
      time += ms
    },
    admission: {
      transactionGroup: db,
      stop: (id: string) => conversations.requestStop(id).pipe(Effect.asVoid),
      admit: (h: typeof handoff, text: string) =>
        conversations
          .admit(
            {
              operationId: h.reportId,
              text,
              origin: { kind: "background", groupId: h.id, turnId: h.turnId },
            },
            undefined,
            [],
            h.route
          )
          .pipe(Effect.map((admission) => admission.turn.id)),
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
  expect(Effect.runSync(f.reopen().create(brief, f.source)).handoff).toEqual(
    f.handoff
  )
  expect(() =>
    Effect.runSync(
      f.mailbox.create({ ...brief, objective: "Changed" }, f.source)
    )
  ).toThrow("different request")
  Effect.runSync(f.mailbox.observed(19, f.result))
  expect(Effect.runSync(f.mailbox.deliver(f.admission))).toBe(false)
  f.status("done")
  Effect.runSync(
    f.conversations.setSettings({ model: "gpt-6-astra", thinking: "high" })
  )
  expect(Effect.runSync(f.reopen().deliver(f.admission))).toBe(true)
  expect(Effect.runSync(f.reopen().deliver(f.admission))).toBe(false)
  const turns = Effect.runSync(f.conversations.recent())
  expect(turns).toHaveLength(1)
  expect(turns[0]!.routing).toEqual(route)
  expect(turns[0]!.origin).toEqual({
    kind: "background",
    groupId: 19,
    turnId: f.source.turnId,
  })
  expect(Effect.runSync(f.mailbox.authorized(19))).toBe(false)
})

it("rolls back report acknowledgement and conversation admission together", () => {
  const f = fixture()
  f.status("done")
  Effect.runSync(f.mailbox.observed(19, f.result))
  expect(() =>
    Effect.runSync(
      f.mailbox.deliver({
        ...f.admission,
        admit: (h, text) =>
          f
            .admit(h, text)
            .pipe(Effect.andThen(() => Effect.die(new Error("crash")))),
      })
    )
  ).toThrow("crash")
  expect(Effect.runSync(f.conversations.recent())).toHaveLength(0)
  expect(Effect.runSync(f.mailbox.get(19))!.status).toBe("ready")
  expect(Effect.runSync(f.reopen().deliver(f.admission))).toBe(true)
})

it("repeated report retries preserve trusted provenance and archive as events", () => {
  const f = fixture()
  f.status("done")
  Effect.runSync(f.mailbox.observed(19, f.result))
  Effect.runSync(f.mailbox.deliver(f.admission))
  let turn = Effect.runSync(f.conversations.get(f.handoff.reportId))!
  for (let n = 0; n < 2; n++) {
    Effect.runSync(
      f.conversations.finish(
        turn,
        [{ id: turn.id, delivery: "unanswered" }],
        "",
        "Interrupted"
      )
    )
    turn = Effect.runSync(
      f.conversations.admit({
        operationId: crypto.randomUUID(),
        text: turn.text,
        retryOf: turn.id,
      })
    ).turn
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
    if (kind === "owner") Effect.runSync(f.mailbox.cancel(19))
    if (kind === "deadline") f.advance(600000)
    Effect.runSync(f.mailbox.reconcileCancellation())
    Effect.runSync(f.mailbox.observed(19, f.result))
    f.status("done")
    expect(Effect.runSync(f.mailbox.authorized(19))).toBe(false)
    expect(Effect.runSync(f.mailbox.deliver(f.admission))).toBe(false)
    expect(Effect.runSync(f.mailbox.get(19))!.status).toBe("cancelled")
  }
)

it("bounds transport retries, retains a deadline wake, and reuses explicit retry identity", () => {
  const f = fixture()
  for (let n = 0; n < 5; n++) Effect.runSync(f.mailbox.failed(19))
  expect(Effect.runSync(f.mailbox.get(19))!.status).toBe("paused")
  expect(Effect.runSync(f.mailbox.due())).toHaveLength(0)
  expect(Effect.runSync(f.mailbox.nextWake())).toBe(f.handoff.deadline)
  const id = crypto.randomUUID()
  expect(Effect.runSync(f.reopen().retry(19, id))).toBe(true)
  expect(Effect.runSync(f.reopen().retry(19, id))).toBe(false)
  expect(Effect.runSync(f.mailbox.get(19))!.handoff.reportId).toBe(
    f.handoff.reportId
  )
})

it("does not admit a result whose RPC acknowledgement arrives after the deadline", () => {
  const f = fixture()
  f.status("done")
  expect(Effect.runSync(f.mailbox.due())).toHaveLength(1)
  f.advance(600001)
  Effect.runSync(f.mailbox.observed(19, f.result))
  expect(Effect.runSync(f.mailbox.get(19))!.status).toBe("cancelled")
  expect(Effect.runSync(f.mailbox.deliver(f.admission))).toBe(false)
})

it("isolates bots, validates report ownership and limits unfinished groups", () => {
  const f = fixture(),
    other = makeBackgroundMailbox(
      new SqliteBackgroundMailbox(database()),
      () => Effect.sync(() => "done"),
      "other",
      () => crypto.randomUUID()
    )
  expect(Effect.runSync(other.get(19))).toBeUndefined()
  expect(Effect.runSync(other.authorized(19))).toBe(false)
  expect(() =>
    Effect.runSync(f.mailbox.observed(19, { ...f.result, turnId: "foreign" }))
  ).toThrow("ownership")
  Effect.runSync(
    f.mailbox.create(brief, {
      ...f.source,
      taskId: 20,
      turnId: crypto.randomUUID(),
    })
  )
  expect(() =>
    Effect.runSync(
      f.mailbox.create(brief, {
        ...f.source,
        taskId: 21,
        turnId: crypto.randomUUID(),
      })
    )
  ).toThrow("two unfinished")
})

function application(
  f: ReturnType<typeof fixture>,
  remote: Partial<BackgroundRemote> = {},
  host: Partial<BackgroundHost> = {}
) {
  return makeBackgroundDelegation(
    f.mailbox,
    {
      start: () => Effect.succeed(f.result),
      read: () => Effect.succeed(f.result),
      stop: () => Effect.void,
      control: () => Effect.succeed({ accepted: true }),
      transcript: () => Effect.succeed({ entries: [], cursor: null }),
      ...remote,
    },
    {
      active: () => Effect.succeed(false),
      backgroundActive: () => Effect.succeed(false),
      wakeConversation: () => Effect.void,
      wakeBackground: () => Effect.void,
      notify: () => Effect.void,
      admission: f.admission,
      ...host,
    }
  )
}

it.each(["storage", "identity"])(
  "rejects a different admission %s and rolls back writes",
  async (mode) => {
    const f = fixture()
    f.status("done")
    Effect.runSync(f.mailbox.observed(19, f.result))
    let called = false
    const exit = await Effect.runPromiseExit(
      f.mailbox.deliver({
        ...f.admission,
        transactionGroup: mode === "storage" ? {} : f.db,
        admit: (h, report) =>
          Effect.sync(() => {
            called = true
          }).pipe(
            Effect.andThen(() => f.admission.admit(h, report)),
            Effect.as("wrong-identity")
          ),
      })
    )
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    expect(called).toBe(mode === "identity")
    expect(Effect.runSync(f.conversations.recent())).toEqual([])
    expect(Effect.runSync(f.mailbox.get(19))?.status).toBe("ready")
  }
)

it("rolls back a retry receipt when the same native transaction cannot resume the handoff", async () => {
  const f = fixture()
  for (let n = 0; n < 5; n++) Effect.runSync(f.mailbox.failed(19))
  f.db.run(
    "CREATE TRIGGER refuse_retry BEFORE UPDATE ON background_handoffs WHEN OLD.status='paused' AND NEW.status='pending' BEGIN SELECT RAISE(ABORT,'private database fault'); END"
  )
  const operation = crypto.randomUUID()
  const exit = await Effect.runPromiseExit(f.mailbox.retry(19, operation))
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false)
  expect(
    Exit.isFailure(exit) &&
      exit.cause.reasons.some(
        (reason) =>
          reason._tag === "Fail" &&
          reason.error._tag === "BackgroundStorageError"
      )
  ).toBe(true)
  expect(
    Effect.runSync(new SqliteBackgroundMailbox(f.db).retry(operation))
  ).toBeUndefined()
  expect(Effect.runSync(f.mailbox.get(19))?.status).toBe("paused")
})

it.each(["invalid-json", "wrong-id", "missing-report"])(
  "keeps corrupt %s records as defects",
  async (mode) => {
    const f = fixture()
    if (mode === "invalid-json")
      corrupt(f.db, "UPDATE background_handoffs SET handoff='corrupt'")
    if (mode === "wrong-id")
      corrupt(
        f.db,
        "UPDATE background_handoffs SET handoff=?",
        JSON.stringify({ ...f.handoff, id: 20 })
      )
    if (mode === "missing-report")
      corrupt(f.db, "UPDATE background_handoffs SET status='ready',report=NULL")
    let calls = 0
    const exit = await Effect.runPromiseExit(
      application(f, {
        start: () => {
          calls++
          return Effect.succeed(f.result)
        },
      }).step()
    )
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    expect(calls).toBe(0)
  }
)

it("does not spend transport retries on an ownership conflict", async () => {
  const f = fixture()
  const exit = await Effect.runPromiseExit(
    application(f, {
      start: () => Effect.succeed({ ...f.result, turnId: "foreign" }),
    }).step()
  )
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false)
  expect(
    Exit.isFailure(exit) &&
      exit.cause.reasons.some(
        (reason) =>
          reason._tag === "Fail" &&
          reason.error._tag === "DelegationFailure" &&
          reason.error.code === "conflict"
      )
  ).toBe(true)
  expect(Effect.runSync(f.mailbox.get(19))?.failures).toBe(0)
})

it("spends one retry on a remote outage and keeps report identity", async () => {
  const f = fixture()
  const next = await Effect.runPromise(
    application(f, {
      start: () =>
        Effect.fail(
          new DelegationFailure({
            code: "unavailable",
            message: "Remote unavailable",
          })
        ),
    }).step()
  )
  expect(next).toBe(11000)
  expect(Effect.runSync(f.mailbox.get(19))).toMatchObject({
    failures: 1,
    handoff: { reportId: f.handoff.reportId },
  })
})

effectIt.effect(
  "uses the invocation Clock for admission, polling and expiry",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      const mailbox = makeBackgroundMailbox(
        new SqliteBackgroundMailbox(database()),
        () => Effect.sync(() => "active"),
        "owner-bot",
        () => crypto.randomUUID()
      )
      const row = yield* mailbox.create(brief, f.source)
      expect(row.handoff.createdAt).toBe(0)
      yield* TestClock.adjust(5000)
      yield* mailbox.observed(19, { ...f.result, status: "working" })
      expect(yield* mailbox.nextWake()).toBe(10000)
      yield* TestClock.adjust(595000)
      expect(yield* mailbox.authorized(19)).toBe(false)
      yield* mailbox.reconcileCancellation()
      expect((yield* mailbox.get(19))?.status).toBe("cancelled")
    })
)

it("does not admit durable background work for an already cancelled caller", async () => {
  const f = fixture(),
    controller = new AbortController()
  controller.abort()
  let wakes = 0
  const app = application(
    f,
    {},
    {
      wakeBackground: () =>
        Effect.sync(() => {
          wakes++
        }),
    }
  )
  const exit = await Effect.runPromiseExit(
    app.create(
      { objective: "New", tasks: [{ name: "Draft", task: "Private" }] },
      { ...f.source, taskId: 20, turnId: "new-parent" }
    ),
    { signal: controller.signal }
  )
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(Effect.runSync(f.mailbox.get(20))).toBeUndefined()
  expect(wakes).toBe(0)
})

it("joins interrupted native RPC settlement without recording an observation or transport failure", async () => {
  const f = fixture(),
    entered = gate<void>(),
    reply = gate<Group>(),
    controller = new AbortController()
  const app = application(f, {
    start: () =>
      backgroundNative(() => {
        entered.release()
        return reply.promise
      }),
  })
  let settled = false
  const running = Effect.runPromiseExit(app.step(), {
    signal: controller.signal,
  }).then((exit) => {
    settled = true
    return exit
  })
  try {
    await entered.promise
    controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    reply.release(f.result)
    const exit = await running
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(Effect.runSync(f.mailbox.get(19))).toMatchObject({
      status: "pending",
      failures: 0,
    })
  } finally {
    reply.release(f.result)
    await running
  }
})

it("shows a Stop committed while a native read was in flight", async () => {
  const f = fixture(),
    entered = gate<void>(),
    reply = gate<Group>()
  const app = application(f, {
    read: () =>
      backgroundNative(() => {
        entered.release()
        return reply.promise
      }),
  })
  const reading = Effect.runPromise(app.read(19))
  try {
    await entered.promise
    Effect.runSync(f.mailbox.cancel(19))
    reply.release(f.result)
    expect(await reading).toMatchObject({
      status: "cancelled",
      background: { delivery: "cancelled" },
    })
  } finally {
    reply.release(f.result)
    await reading
  }
})

it("redacts native storage failures at the background HTTP boundary", async () => {
  const f = fixture()
  f.db.run("DROP TABLE background_handoffs")
  const records = new SqliteBackgroundMailbox(f.db)
  const mailbox = makeBackgroundMailbox(
    records,
    () => Effect.sync(() => "active"),
    "owner-bot",
    () => crypto.randomUUID()
  )
  const app = makeBackgroundDelegation(
    mailbox,
    {
      start: () => Effect.succeed(f.result),
      read: () => Effect.succeed(f.result),
      stop: () => Effect.void,
      control: () => Effect.succeed({ accepted: true }),
      transcript: () => Effect.succeed({ entries: [], cursor: null }),
    },
    {
      active: () => Effect.succeed(false),
      backgroundActive: () => Effect.succeed(false),
      wakeBackground: () => Effect.void,
      wakeConversation: () => Effect.void,
      notify: () => Effect.void,
      admission: f.admission,
    }
  )
  const response = await Effect.runPromise(
    backgroundRequest(
      app,
      new Request("https://example.com/background"),
      "background"
    )
  )
  expect(response.status).toBe(503)
  expect(await response.text()).not.toContain("private")
})

it("does not turn a tagged remote defect into a fallback view", async () => {
  const f = fixture()
  const exit = await Effect.runPromiseExit(
    application(f, {
      read: () =>
        Effect.die(
          new DelegationFailure({ code: "unavailable", message: "invariant" })
        ),
    }).read(19)
  )
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
})

it.each(["pending", "paused", "cancelled"])(
  "projects an uninitialized remote group while its handoff is %s",
  async (status) => {
    const f = fixture()
    if (status === "paused")
      for (let index = 0; index < 5; index++)
        Effect.runSync(f.mailbox.failed(19))
    if (status === "cancelled") Effect.runSync(f.mailbox.cancel(19))
    const app = application(f, {
      read: () =>
        Effect.fail(
          new DelegationFailure({
            code: "not_found",
            message: "Not initialized",
          })
        ),
    })
    expect(await Effect.runPromise(app.read(19))).toMatchObject({
      status: status === "cancelled" ? "cancelled" : "working",
      children: [],
      background: { delivery: status },
    })
  }
)

it.each(["running", "ready"])(
  "surfaces a missing remote group after a %s acknowledgement",
  async (status) => {
    const f = fixture()
    Effect.runSync(
      f.mailbox.observed(19, {
        ...f.result,
        status: status === "running" ? "working" : "completed",
      })
    )
    const app = application(f, {
      read: () =>
        Effect.fail(
          new DelegationFailure({
            code: "not_found",
            message: "Missing committed group",
          })
        ),
    })
    const exit = await Effect.runPromiseExit(app.read(19))
    expect(
      Exit.isFailure(exit) &&
        exit.cause.reasons.some(
          (reason) =>
            reason._tag === "Fail" &&
            reason.error._tag === "DelegationFailure" &&
            reason.error.code === "not_found"
        )
    ).toBe(true)
  }
)

it.each(["failure", "interruption"])(
  "retains a local native Cause %s and its annotations",
  async (kind) => {
    class Trace extends Context.Service<Trace, string>()("BackgroundTrace") {}
    const error = new DelegationFailure({
      code: "conflict",
      message: "Typed conflict",
    })
    Object.setPrototypeOf(error, Error.prototype)
    const reason =
      kind === "failure"
        ? Cause.makeFailReason(error)
        : Cause.makeInterruptReason(17)
    const cause = Cause.fromReasons([
      reason.annotate(Context.make(Trace, "kept")),
    ])
    const exit = await Effect.runPromiseExit(
      backgroundNative(() => Promise.reject(cause))
    )
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false)
    expect(
      Exit.isFailure(exit) &&
        exit.cause.reasons.some(
          (value) =>
            value._tag === reason._tag &&
            value.annotations.get(Trace.key) === "kept"
        )
    ).toBe(true)
  }
)

it("joins and retains a late local native Cause defect after interruption", async () => {
  const entered = gate<void>(),
    reply = gate<void>(),
    controller = new AbortController()
  const defect = new Error("Native cleanup defect")
  let settled = false
  const running = Effect.runPromiseExit(
    backgroundNative(() => {
      entered.release()
      return reply.promise
    }),
    { signal: controller.signal }
  ).then((exit) => {
    settled = true
    return exit
  })
  try {
    await entered.promise
    controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    reply.reject(Cause.die(defect))
    const exit = await running
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(
      Exit.isFailure(exit) &&
        exit.cause.reasons.some(
          (reason) => reason._tag === "Die" && reason.defect === defect
        )
    ).toBe(true)
  } finally {
    reply.release()
    await running
  }
})

it("bounds background HTTP input and joins reader cleanup before rejecting it", async () => {
  const f = fixture(),
    cleaning = gate<void>(),
    release = gate<void>()
  const options: RequestInit & { duplex: "half" } = {
    method: "POST",
    duplex: "half",
    body: new ReadableStream<Uint8Array>({
      start(target) {
        target.enqueue(new Uint8Array(40001))
      },
      async cancel() {
        cleaning.release()
        await release.promise
      },
    }),
  }
  let settled = false
  const running = Effect.runPromise(
    backgroundRequest(
      application(f),
      new Request("https://local/background/stop", options),
      "background/stop"
    )
  ).then((response) => {
    settled = true
    return response
  })
  try {
    await cleaning.promise
    expect(settled).toBe(false)
    release.release()
    expect((await running).status).toBe(400)
    expect(Effect.runSync(f.mailbox.get(19))?.status).toBe("pending")
  } finally {
    release.release()
    await running
  }
})

it.each(["stop", "retry", "control"])(
  "does not apply %s for an already cancelled caller",
  async (operation) => {
    const f = fixture(),
      controller = new AbortController()
    if (operation === "retry")
      for (let n = 0; n < 5; n++) Effect.runSync(f.mailbox.failed(19))
    const before = Effect.runSync(f.mailbox.get(19))
    controller.abort()
    let calls = 0
    const app = application(f, {
      stop: () =>
        Effect.sync(() => {
          calls++
        }),
      control: () =>
        Effect.sync(() => {
          calls++
          return { accepted: true }
        }),
    })
    const work =
      operation === "stop"
        ? app.stop(19)
        : operation === "retry"
          ? app.retry(19, crypto.randomUUID())
          : app.control({
              groupId: 19,
              childId: 2,
              operationId: crypto.randomUUID(),
              action: { type: "stop" },
            })
    const exit = await Effect.runPromiseExit(work, {
      signal: controller.signal,
    })
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(Effect.runSync(f.mailbox.get(19))).toEqual(before)
    expect(calls).toBe(0)
  }
)

it("retains a typed conversation rejection without requiring its class prototype", async () => {
  const f = fixture(),
    error = new ConversationFull()
  Object.setPrototypeOf(error, Error.prototype)
  f.status("done")
  Effect.runSync(f.mailbox.observed(19, f.result))
  const exit = await Effect.runPromiseExit(
    f.mailbox.deliver({
      ...f.admission,
      admit: () => Effect.fail(error),
    })
  )
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false)
  expect(
    Exit.isFailure(exit) &&
      exit.cause.reasons.some(
        (reason) =>
          reason._tag === "Fail" && reason.error._tag === "ConversationFull"
      )
  ).toBe(true)
  expect(Effect.runSync(f.mailbox.get(19))?.status).toBe("ready")
})

it("rolls back report Stop when its shared native transaction fails", async () => {
  const f = fixture()
  f.status("done")
  Effect.runSync(f.mailbox.observed(19, f.result))
  Effect.runSync(f.mailbox.deliver(f.admission))
  const before = Effect.runSync(f.conversations.get(f.handoff.reportId))
  const exit = await Effect.runPromiseExit(
    f.mailbox.cancel(19, {
      ...f.admission,
      stop: (id) =>
        f.admission
          .stop(id)
          .pipe(
            Effect.andThen(() =>
              Effect.die(new Error("Stop transaction failed"))
            )
          ),
    })
  )
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(Effect.runSync(f.conversations.get(f.handoff.reportId))).toEqual(
    before
  )
  expect(Effect.runSync(f.mailbox.get(19))?.status).toBe("delivered")
})

it("bounds historical listing to two concurrent remote reads", async () => {
  const f = fixture(),
    records = new SqliteBackgroundMailbox(f.db),
    entered = gate<void>(),
    reply = gate<void>()
  const row = Effect.runSync(f.mailbox.get(19))!
  for (let id = 100; id < 120; id++)
    Effect.runSync(
      records.put({
        ...row,
        id,
        turn_id: `parent-${id}`,
        status: "delivered",
        report: "Historical report",
        handoff: {
          ...row.handoff,
          id,
          turnId: `parent-${id}`,
          reportId: crypto.randomUUID(),
        },
      })
    )
  let active = 0,
    maximum = 0,
    calls = 0
  const app = application(f, {
    read: (id) =>
      backgroundNative(async () => {
        active++
        calls++
        maximum = Math.max(maximum, active)
        if (calls === 2) entered.release()
        try {
          await reply.promise
          return {
            ...f.result,
            id,
            turnId: Effect.runSync(records.get(id))!.turn_id,
          }
        } finally {
          active--
        }
      }),
  })
  const running = Effect.runPromise(app.list())
  try {
    await entered.promise
    expect(maximum).toBe(2)
    reply.release()
    const groups = await running
    expect(groups).toHaveLength(20)
    expect(maximum).toBe(2)
    expect(calls).toBe(20)
    expect(active).toBe(0)
  } finally {
    reply.release()
    await running
  }
})
