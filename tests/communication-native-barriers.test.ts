/**
 * Real SQLite/mailbox, real application and native adapter; only native bridge
 * completion and saved native documents are fake, with explicit Promise barriers.
 * The first two tests fail on the reviewed warm-pump ownership gap.
 */
import { setImmediate } from "node:timers/promises"

import type { Harness } from "@earendil-works/pi-durable"
import { Cause, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect"
import { expect, it } from "vitest"

import { AgentId } from "../src/agents/domain"
import { piMailbox } from "../src/communication/adapters/pi"
import { sqliteMailbox } from "../src/communication/adapters/sqlite"
import {
  Communication,
  makeCommunication,
} from "../src/communication/communication"
import {
  STOP_DEADLINE_MS,
  RESULT_WINDOW_MS,
  type Envelope,
} from "../src/communication/contracts"
import { TaskExecution } from "../src/communication/execution"
import { ContinuationIdentity } from "../src/communication/identity"
import { Mailbox, MailboxTransport } from "../src/communication/mailbox"
import { resolveRoute } from "../src/inference/policy"
import { database } from "./database"

const run = Effect.runPromise
function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
async function fixture(
  bridge: Parameters<typeof piMailbox>[1],
  permit = () => Effect.succeed(true),
  options: {
    saved?: Record<string, unknown> | null
    restore?: boolean
    receipt?: "missing" | "pending"
    createdAt?: number
  } = {}
) {
  const db = database(),
    repository = sqliteMailbox(db)
  const mailbox = Effect.runSync(repository.initialize)
  const bot = Schema.decodeUnknownSync(AgentId)(
    "00000000-0000-4000-8000-000000000001"
  )
  await run(repository.bindIdentity({ owner: "synthetic-owner", bot }))
  const now = Date.now()
  const envelope: Envelope = {
    version: 1,
    id: "barrier-task",
    taskId: "barrier-task",
    owner: "synthetic-owner",
    from: Schema.decodeUnknownSync(AgentId)("home"),
    to: bot,
    correlationId: "source-turn",
    causationId: "source-tool",
    depth: 1,
    createdAt: options.createdAt ?? now,
    deadline: (options.createdAt ?? now) + 600_000,
    payload: {
      kind: "task",
      objective: "Compare drafts",
      context: "Synthetic only",
    },
  }
  await run(mailbox.accept(envelope, now, { discoveryDeadline: now + 60_000 }))
  const saved = {
    conversation: 91,
    provider: "pinned-provider",
    requests: 0,
    route: {
      ...resolveRoute("conversation", { model: "gpt-6-luna", thinking: "low" }),
      contextWindow: 8192,
    },
  }
  const doc = {
    value:
      options.saved === null
        ? ""
        : JSON.stringify({ ...saved, ...options.saved }),
  }
  let receiptReads = 0
  const harness = {
    snapshot: async () => ({ ...doc, task: envelope.id }),
    commit: async (body: (tx: unknown) => unknown) =>
      body({
        doc: async () => doc,
        submissionByRequest: async () => {
          receiptReads++
          if (options.receipt === "missing") return undefined
          return {
            type: "input",
            status: "queued",
            requestId: `communication:${envelope.id}`,
          }
        },
      }),
  } as unknown as Harness
  const transport: MailboxTransport["Service"] = {
    permitted: permit,
    authenticate: () => Effect.void,
    deliver: (e) =>
      Effect.succeed({ id: e.id, taskId: e.taskId, acceptedAt: Date.now() }),
  }
  const native = piMailbox(
    async () => harness,
    bridge,
    mailbox,
    transport,
    () => Effect.die("The saved execution must retain its route")
  )
  if (options.restore !== false) await run(native.restore(harness))
  const dependencies = Layer.mergeAll(
    Layer.succeed(Mailbox, mailbox),
    Layer.succeed(MailboxTransport, transport),
    Layer.succeed(TaskExecution, native),
    Layer.succeed(ContinuationIdentity, {
      derive: () => Effect.succeed("unused-continuation"),
    })
  )
  const runtime = ManagedRuntime.make(
    Layer.effect(
      Communication,
      makeCommunication({
        transactionGroup: db,
        current: () => Effect.succeed("active"),
        idle: () => Effect.succeed(false),
        contacts: () => Effect.succeed([]),
        prepare: () => Effect.void,
        wake: () => Effect.void,
        armMailbox: () => Effect.succeed(Date.now() + 60_000),
        prearm: () => Effect.succeed(Date.now() + 60_000),
        wakeConversation: () => Effect.void,
        notify: () => {},
        resume: () => Effect.die("No outgoing continuation in this fixture"),
      })
    ).pipe(Layer.provide(dependencies))
  )
  const app = await runtime.runPromise(Communication)
  const cancel = () =>
    run(
      mailbox.accept(
        {
          ...envelope,
          id: `cancel:${envelope.id}`,
          causationId: envelope.id,
          payload: { kind: "cancel", reason: "Synthetic stop" },
        },
        Date.now()
      )
    )
  return {
    db,
    harness,
    transport,
    app,
    runtime,
    native,
    mailbox,
    envelope,
    cancel,
    doc,
    receiptReads: () => receiptReads,
  }
}

it("keeps warm pump ownership through a held submit before processing cancellation", async () => {
  const entered = gate(),
    release = gate(),
    events: string[] = []
  const f = await fixture({
    submit: async () => {
      events.push("submit.enter")
      entered.release()
      await release.promise
      events.push("submit.settled")
    },
    abort: async () => {
      events.push("abort.settled")
    },
  })
  const first = f.runtime.runPromise(f.app.pump())
  let replacement: Promise<unknown> | undefined
  try {
    await entered.promise
    await f.cancel()
    replacement = f.runtime.runPromise(f.app.pump())
    // Drain local runnable work; every foreign completion is controlled by a gate.
    await setImmediate()
    expect(events).toEqual(["submit.enter"])
    expect((await run(f.mailbox.task(f.envelope.id))).status).toBe("cancelling")
    expect(f.native.pins()).toHaveLength(1)
    release.release()
    await Promise.all([first, replacement])
    await f.runtime.runPromise(f.app.pump())
    expect(events).toEqual(["submit.enter", "submit.settled", "abort.settled"])
    expect((await run(f.mailbox.task(f.envelope.id))).status).toBe("cancelled")
    expect(f.native.pins()).toHaveLength(0)
  } finally {
    release.release()
    await Promise.allSettled([first, replacement])
    await f.runtime.dispose()
  }
})

it("keeps warm pump ownership while native abort joins its held cleanup", async () => {
  const entered = gate(),
    release = gate()
  let aborts = 0,
    active = 0,
    maximum = 0
  const f = await fixture({
    submit: async () => {},
    abort: async () => {
      aborts++
      active++
      maximum = Math.max(maximum, active)
      try {
        if (aborts === 1) {
          entered.release()
          await release.promise
        }
      } finally {
        active--
      }
    },
  })
  await f.cancel()
  const first = f.runtime.runPromise(f.app.pump())
  let replacement: Promise<unknown> | undefined
  try {
    await entered.promise
    replacement = f.runtime.runPromise(f.app.pump())
    await setImmediate()
    expect(aborts).toBe(1)
    expect((await run(f.mailbox.task(f.envelope.id))).status).toBe("cancelling")
    expect(f.native.pins()).toHaveLength(1)
    release.release()
    await Promise.all([first, replacement])
    await f.runtime.runPromise(f.app.pump())
    expect(maximum).toBe(1)
    expect((await run(f.mailbox.task(f.envelope.id))).status).toBe("cancelled")
  } finally {
    release.release()
    await Promise.allSettled([first, replacement])
    await f.runtime.dispose()
  }
})

it("joins held native submit on local interruption and skips the later receipt read", async () => {
  const entered = gate(),
    release = gate(),
    controller = new AbortController()
  const f = await fixture({
    submit: async () => {
      entered.release()
      await release.promise
    },
    abort: async () => {},
  })
  const task = (await run(
    f.mailbox.claimTask(Date.now(), {
      owner: "native-join",
      deadline: Date.now() + 60_000,
    })
  ))!
  let ended = false
  const pending = Effect.runPromiseExit(f.native.advance(task), {
    signal: controller.signal,
  }).then((exit) => {
    ended = true
    return exit
  })
  try {
    await entered.promise
    controller.abort()
    await setImmediate()
    expect(ended).toBe(false)
    release.release()
    const exit = await pending
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(f.receiptReads()).toBe(0)
  } finally {
    release.release()
    await pending
    await f.runtime.dispose()
  }
})

it("denies a model request cancelled during permission RPC without refunding its consumed budget", async () => {
  const entered = gate(),
    release = gate()
  const f = await fixture(
    { submit: async () => {}, abort: async () => {} },
    () =>
      Effect.promise(async () => {
        entered.release()
        await release.promise
        return true
      })
  )
  const pending = Effect.runPromiseExit(f.native.request("pinned-provider"))
  try {
    await entered.promise
    await f.cancel()
    release.release()
    const exit = await pending
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit))
      expect(exit.cause.reasons).toContainEqual(
        expect.objectContaining({
          _tag: "Fail",
          error: expect.objectContaining({ code: "forbidden" }),
        })
      )
    const persisted = JSON.parse(f.doc.value)
    expect(persisted.requests).toBe(1)
    expect(persisted.provider).toBe("pinned-provider")
    expect(persisted.route.contextWindow).toBe(8192)
  } finally {
    release.release()
    await pending
    await f.runtime.dispose()
  }
})

it.each(["submit", "abort"] as const)(
  "replays only a joined %s release after its SQLite acknowledgement fails",
  async (operation) => {
    const entered = gate(),
      release = gate()
    const calls = { submit: 0, abort: 0 }
    let joined = false
    const f = await fixture({
      submit: async () => {
        calls.submit++
        if (operation === "submit") {
          entered.release()
          await release.promise
          joined = true
        }
      },
      abort: async () => {
        calls.abort++
        if (operation === "abort") {
          entered.release()
          await release.promise
          joined = true
        }
      },
    })
    if (operation === "abort") await f.cancel()
    const pending = f.runtime.runPromiseExit(f.app.pump())
    try {
      await entered.promise
      const owner = (await run(f.mailbox.task(f.envelope.id))).control.owner
      expect(owner).not.toBeNull()
      f.db.run(`CREATE TRIGGER fail_release BEFORE UPDATE ON communication_tasks
      WHEN json_extract(OLD.body, '$.control.owner') IS NOT NULL
       AND json_extract(NEW.body, '$.control.owner') IS NULL
      BEGIN SELECT RAISE(ABORT, 'held release acknowledgement'); END`)
      release.release()
      expect(Exit.isFailure(await pending)).toBe(true)
      expect(joined).toBe(true)
      expect((await run(f.mailbox.task(f.envelope.id))).control.owner).toBe(
        owner
      )
      expect(f.native.pins()).toHaveLength(1)
      // Cancellation is independent of release reconciliation, including a new
      // cancellation accepted while the previous submit's receipt is held.
      await f.cancel()
      const cancelled = await run(f.mailbox.task(f.envelope.id))
      expect(cancelled.cancelRequested).toBe(true)
      expect(cancelled.control.owner).toBe(owner)
      const beforeRetry = { ...calls }
      expect(Exit.isFailure(await f.runtime.runPromiseExit(f.app.pump()))).toBe(
        true
      )
      expect(calls).toEqual(beforeRetry)
      f.db.run("DROP TRIGGER fail_release")
      await f.runtime.runPromise(f.app.pump())
      const done = await run(f.mailbox.task(f.envelope.id))
      expect(done.status).toBe("cancelled")
      expect(done.control.owner).toBeNull()
      expect(done.stop.status).toBe("confirmed")
      expect(f.native.pins()).toHaveLength(0)
      expect(calls).toEqual({
        submit: operation === "submit" ? 1 : 0,
        abort: 1,
      })
    } finally {
      release.release()
      f.db.run("DROP TRIGGER IF EXISTS fail_release")
      await pending
      await f.runtime.dispose()
    }
  }
)

it("migrates legacy execution data in place and retains its exhausted budget on restoration", async () => {
  const bridge = { submit: async () => {}, abort: async () => {} }
  const f = await fixture(bridge, undefined, { saved: { requests: 2 } })
  try {
    const migrated = JSON.parse(f.doc.value)
    expect(migrated).toMatchObject({
      schemaVersion: 1,
      workflowVersion: 1,
      nativeVersion: "pi-durable@1.3.0",
      conversation: 91,
      provider: "pinned-provider",
      requests: 2,
    })
    expect(await run(f.native.request("pinned-provider"))).toBe(true)
    expect(JSON.parse(f.doc.value).requests).toBe(3)
    const restored = piMailbox(
      async () => f.harness,
      bridge,
      f.mailbox,
      f.transport,
      () => Effect.die("Restoration must not choose new settings")
    )
    await run(restored.restore(f.harness))
    expect(restored.pin("pinned-provider")).toMatchObject({
      conversation: 91,
      requests: 3,
      route: migrated.route,
    })
    const denied = await Effect.runPromiseExit(
      restored.request("pinned-provider")
    )
    expect(Exit.isFailure(denied)).toBe(true)
    if (Exit.isFailure(denied))
      expect(denied.cause.reasons).toContainEqual(
        expect.objectContaining({
          _tag: "Fail",
          error: expect.objectContaining({ code: "limit" }),
        })
      )
    expect(JSON.parse(f.doc.value)).toEqual({ ...migrated, requests: 3 })
  } finally {
    await f.runtime.dispose()
  }
})

it.each([
  { schemaVersion: 2, workflowVersion: 1, nativeVersion: "pi-durable@1.3.0" },
  { schemaVersion: 1, workflowVersion: 2, nativeVersion: "pi-durable@1.3.0" },
  { schemaVersion: 1, workflowVersion: 1, nativeVersion: "future-pi" },
  { schemaVersion: 1 },
  { requests: -1 },
])(
  "retains incompatible saved native execution for explicit recovery: %j",
  async (saved) => {
    const f = await fixture(
      {
        submit: async () => {
          throw new Error("Unexpected submit")
        },
        abort: async () => {
          throw new Error("Unexpected abort")
        },
      },
      undefined,
      { saved, restore: false }
    )
    const original = f.doc.value
    try {
      const restored = await Effect.runPromiseExit(f.native.restore(f.harness))
      expect(Exit.isFailure(restored)).toBe(true)
      if (Exit.isFailure(restored))
        expect(restored.cause.reasons).toContainEqual(
          expect.objectContaining({
            _tag: "Fail",
            error: expect.objectContaining({ code: "storage" }),
          })
        )
      expect(f.doc.value).toBe(original)
      expect(f.native.pins()).toHaveLength(0)
    } finally {
      await f.runtime.dispose()
    }
  }
)

it("rejects a mismatched persisted provider binding before consuming a model request", async () => {
  const f = await fixture(
    { submit: async () => {}, abort: async () => {} },
    undefined,
    { saved: { provider: "another-provider" } }
  )
  try {
    const denied = await Effect.runPromiseExit(
      f.native.request("pinned-provider")
    )
    expect(Exit.isFailure(denied)).toBe(true)
    if (Exit.isFailure(denied))
      expect(denied.cause.reasons).toContainEqual(
        expect.objectContaining({
          _tag: "Fail",
          error: expect.objectContaining({ code: "storage" }),
        })
      )
    expect(JSON.parse(f.doc.value).requests).toBe(0)
  } finally {
    await f.runtime.dispose()
  }
})

it.each(["submit", "abort"] as const)(
  "retains a late native %s defect while joining interrupted machine work",
  async (operation) => {
    const entered = gate(),
      release = gate(),
      controller = new AbortController()
    const defect = new Error("Late native cleanup defect")
    const held = async () => {
      entered.release()
      await release.promise
      throw Cause.die(defect)
    }
    const f = await fixture({
      submit: operation === "submit" ? held : async () => {},
      abort: operation === "abort" ? held : async () => {},
    })
    const task = (await run(
      f.mailbox.claimTask(Date.now(), {
        owner: "late-defect",
        deadline: Date.now() + 60_000,
      })
    ))!
    if (operation === "abort") await f.cancel()
    let settled = false
    const pending = Effect.runPromiseExit(f.native.advance(task), {
      signal: controller.signal,
    }).then((exit) => {
      settled = true
      return exit
    })
    try {
      await entered.promise
      controller.abort()
      await setImmediate()
      expect(settled).toBe(false)
      release.release()
      const exit = await pending
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      if (Exit.isFailure(exit))
        expect(exit.cause.reasons).toContainEqual(
          expect.objectContaining({ _tag: "Die", defect })
        )
    } finally {
      release.release()
      await pending
      await f.runtime.dispose()
    }
  }
)

it("retains a late native defect when the actual application pump is interrupted", async () => {
  const entered = gate(),
    release = gate(),
    controller = new AbortController()
  const defect = new Error("Late pump-owned native cleanup defect")
  const f = await fixture({
    submit: async () => {
      entered.release()
      await release.promise
      throw Cause.die(defect)
    },
    abort: async () => {},
  })
  let settled = false
  const pending = f.runtime
    .runPromiseExit(f.app.pump(), { signal: controller.signal })
    .then((exit) => {
      settled = true
      return exit
    })
  try {
    await entered.promise
    controller.abort()
    await setImmediate()
    expect(settled).toBe(false)
    expect(
      (await run(f.mailbox.task(f.envelope.id))).control.owner
    ).not.toBeNull()
    release.release()
    const exit = await pending
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    if (Exit.isFailure(exit))
      expect(exit.cause.reasons).toContainEqual(
        expect.objectContaining({ _tag: "Die", defect })
      )
    expect((await run(f.mailbox.task(f.envelope.id))).control.owner).toBeNull()
  } finally {
    release.release()
    await pending
    await f.runtime.dispose()
  }
})

it.each(["pending", "unconfirmed", "none", "confirmed"] as const)(
  "restores terminal task pins only while native stop remains unresolved: %s",
  async (stop) => {
    const f = await fixture({ submit: async () => {}, abort: async () => {} })
    try {
      const now = Date.now()
      const task = (await run(
        f.mailbox.claimTask(now, {
          owner: "terminal-result",
          deadline: now + 60_000,
        })
      ))!
      await run(
        f.mailbox.releaseTask({
          taskId: task.id,
          owner: "terminal-result",
          revision: task.revision,
          now: now + 1,
          outcome: { status: "failed", text: "Immutable terminal result" },
        })
      )
      if (stop !== "none") {
        await f.cancel()
        if (stop !== "pending") {
          const attempt = (await run(
            f.mailbox.claimTask(Date.now(), {
              owner: "terminal-stop",
              deadline: Date.now() + 60_000,
            })
          ))!
          await run(
            f.mailbox.releaseTask({
              taskId: attempt.id,
              owner: "terminal-stop",
              revision: attempt.revision,
              now: Date.now(),
              stop,
            })
          )
        }
      }
      const before = await run(f.mailbox.task(task.id))
      expect(before).toMatchObject({
        status: "failed",
        outcome: { text: "Immutable terminal result" },
        stop: { status: stop },
      })
      await run(f.native.settled(task.id))
      expect(f.native.pins()).toEqual([])
      await run(f.native.restore(f.harness))
      if (stop === "pending" || stop === "unconfirmed")
        expect(f.native.pin("pinned-provider")).toMatchObject({
          taskId: task.id,
          conversation: 91,
          provider: "pinned-provider",
          requests: 0,
          route: { model: "gpt-6-luna", contextWindow: 8192 },
        })
      else expect(f.native.pins()).toEqual([])
      expect(await run(f.mailbox.task(task.id))).toEqual(before)
    } finally {
      await f.runtime.dispose()
    }
  }
)

it.each(["no-execution", "no-receipt", "pending-receipt"] as const)(
  "cold restoration observes the original native identity without new admission: %s",
  async (saved) => {
    let submits = 0,
      configurations = 0
    const bridge = {
      submit: async () => {
        submits++
      },
      abort: async () => {},
    }
    const f = await fixture(bridge, undefined, {
      ...(saved === "no-execution" ? { saved: null } : {}),
      receipt: saved === "no-receipt" ? "missing" : "pending",
    })
    try {
      const first = (await run(
        f.mailbox.claimTask(Date.now(), {
          owner: "crashed-before-ack",
          deadline: Date.now() + 60_000,
        })
      ))!
      expect(first.control.phase).toBe("submit")
      await run(f.mailbox.restoreControl(Date.now()))
      const recovered = (await run(
        f.mailbox.claimTask(Date.now(), {
          owner: "cold-observer",
          deadline: Date.now() + 60_000,
        })
      ))!
      expect(recovered.control.phase).toBe("observe")
      const restored = piMailbox(
        async () => f.harness,
        bridge,
        f.mailbox,
        f.transport,
        () => {
          configurations++
          return Effect.die(
            "Cold restoration must not create a native execution"
          )
        }
      )
      await run(restored.restore(f.harness))
      const original = f.doc.value
      const observed = await Effect.runPromiseExit(restored.advance(recovered))
      expect(configurations).toBe(0)
      expect(submits).toBe(0)
      expect(f.doc.value).toBe(original)
      expect(f.receiptReads()).toBe(saved === "no-execution" ? 0 : 1)
      if (saved === "pending-receipt")
        expect(observed).toEqual(Exit.succeed(undefined))
      else {
        expect(Exit.isFailure(observed)).toBe(true)
        if (Exit.isFailure(observed))
          expect(observed.cause.reasons).toContainEqual(
            expect.objectContaining({
              _tag: "Fail",
              error: expect.objectContaining({ code: "storage" }),
            })
          )
      }
      expect((await run(f.mailbox.task(recovered.id))).outcome).toBeNull()
    } finally {
      await f.runtime.dispose()
    }
  }
)

it("starts the receiver Stop budget at delayed cancellation acceptance and joins one abort", async () => {
  let submitted = 0,
    aborted = 0
  const f = await fixture(
    {
      submit: async () => {
        submitted++
      },
      abort: async () => {
        aborted++
      },
    },
    undefined,
    { createdAt: Date.now() - STOP_DEADLINE_MS - 2000 }
  )
  try {
    const createdAt = f.envelope.createdAt + 1000
    const cancellation: Envelope = {
      ...f.envelope,
      id: `cancel:${f.envelope.id}`,
      causationId: f.envelope.id,
      createdAt,
      deadline: createdAt + RESULT_WINDOW_MS,
      payload: { kind: "cancel", reason: "Delayed transport" },
    }
    const acceptedAt = Date.now()
    const receipt = await run(f.mailbox.accept(cancellation, acceptedAt))
    const pending = await run(f.mailbox.task(f.envelope.id))
    expect(pending.stop).toMatchObject({
      status: "pending",
      attempts: 0,
    })
    expect(pending.stop.deadline).toBe(pending.stop.nextAt! + STOP_DEADLINE_MS)
    expect(pending.stop.nextAt).toBeGreaterThanOrEqual(receipt.acceptedAt)
    expect(pending.stop.deadline).toBeGreaterThan(acceptedAt)
    await f.runtime.runPromise(f.app.pump())
    const settled = await run(f.mailbox.task(f.envelope.id))
    expect(settled).toMatchObject({
      status: "cancelled",
      control: { owner: null },
      stop: { status: "confirmed", attempts: 1 },
    })
    expect(submitted).toBe(0)
    expect(aborted).toBe(1)
    expect(f.native.pins()).toEqual([])
    expect(
      await run(f.mailbox.accept(cancellation, Date.now() + 1000))
    ).toEqual(receipt)
    expect(await run(f.mailbox.task(f.envelope.id))).toEqual(settled)
  } finally {
    await f.runtime.dispose()
  }
})
