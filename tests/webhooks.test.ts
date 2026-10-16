import { describe, expect, it, vi } from "vitest"
import { Cause, Effect, Exit } from "effect"
import { WebhookStorageError } from "../src/webhooks/persistence"
import { database } from "./database"
import { routineFixture, webhookFixture } from "./routine-fixture"
import { WebhookRejected } from "../src/webhooks/contracts"
import { digest } from "../src/webhooks/adapters/crypto"
import {
  webhookIncoming,
  webhookNative,
  webhookOwnerRequest,
} from "../src/webhooks/adapters/http"
import { receiveWebhook } from "../src/webhooks/adapters/public"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"

async function fixture() {
  const db = database()
  let active = true
  const routines = routineFixture(db, () => active)
  const id = crypto.randomUUID()
  routines.save({
    id,
    operationId: crypto.randomUUID(),
    expectedRevision: 0,
    title: "Incoming project update",
    prompt: "Summarize the supplied update.",
    schedule: { type: "webhook" },
    status: "active",
  })
  const store = webhookFixture(db, routines, () => active)
  const key = "rpwh_" + "1".repeat(64),
    hash = await digest(key)
  const change = {
    routineId: id,
    operationId: crypto.randomUUID(),
    expectedRevision: 0,
    hash,
  }
  store.configure(change)
  const payload = JSON.stringify({ status: "ready" }),
    payloadHash = await digest(payload)
  return {
    db,
    id,
    routines,
    store,
    key,
    hash,
    change,
    payload,
    payloadHash,
    archive: () => {
      active = false
    },
  }
}
const rejected = (run: () => unknown, reason: WebhookRejected["reason"]) => {
  try {
    run()
    expect.unreachable("Expected rejection")
  } catch (e) {
    expect(e).toBeInstanceOf(WebhookRejected)
    expect((e as WebhookRejected).reason).toBe(reason)
  }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("inbound webhook authority and durable receipts", () => {
  it("refuses composition across separate receipt and routine databases", async () => {
    const f = await fixture()
    expect(() => webhookFixture(database(), f.routines, () => true)).toThrow(
      "share a storage transaction group"
    )
    expect(f.store.info(f.id).accepted).toBe(0)
    expect(f.routines.inFlight()).toBeUndefined()
  })
  it("stores only key digests; replay and cancellation cannot rotate twice", async () => {
    const f = await fixture()
    expect(f.store.configure(f.change).revision).toBe(1)
    expect(
      JSON.stringify(f.db.all("SELECT * FROM webhook_operations"))
    ).not.toContain(f.key)
    expect(JSON.stringify(f.db.all("SELECT * FROM webhooks"))).not.toContain(
      f.key
    )
    rejected(
      () => f.store.configure({ ...f.change, hash: "2".repeat(64) }),
      "conflict"
    )
    const operationId = crypto.randomUUID()
    expect(f.store.cancel(operationId)).toEqual({ applied: false })
    rejected(
      () =>
        f.store.configure({ ...f.change, expectedRevision: 1, operationId }),
      "conflict"
    )
    expect(f.store.cancel(f.change.operationId)).toEqual({ applied: true })
  })
  it("deduplicates across restart, key rotation and run-history pruning", async () => {
    const f = await fixture(),
      first = f.store.accept(f.id, f.hash, "event-1", f.payload, f.payloadHash)
    const restarted = webhookFixture(f.db, f.routines, () => true)
    expect(
      restarted.accept(f.id, f.hash, "event-1", f.payload, f.payloadHash)
    ).toEqual({ ...first, duplicate: true })
    rejected(
      () => restarted.accept(f.id, f.hash, "event-1", "{}", "different"),
      "conflict"
    )
    const hash = await digest("rpwh_" + "2".repeat(64))
    restarted.configure({
      ...f.change,
      operationId: crypto.randomUUID(),
      expectedRevision: 1,
      hash,
    })
    f.db.run("DELETE FROM routine_runs")
    expect(
      restarted.accept(f.id, hash, "event-1", f.payload, f.payloadHash)
    ).toEqual({ ...first, duplicate: true })
    rejected(
      () => restarted.accept(f.id, f.hash, "event-1", f.payload, f.payloadHash),
      "unauthorized"
    )
  })
  it("refuses concurrent work without accepting a receipt; same event can retry when free", async () => {
    const f = await fixture(),
      first = f.store.accept(f.id, f.hash, "event-1", f.payload, f.payloadHash)
    rejected(
      () => f.store.accept(f.id, f.hash, "event-2", f.payload, f.payloadHash),
      "busy"
    )
    expect(f.store.info(f.id).accepted).toBe(1)
    f.routines.cancelPendingRun(first.runId)
    expect(
      f.store.accept(f.id, f.hash, "event-2", f.payload, f.payloadHash)
        .duplicate
    ).toBe(false)
    expect(f.routines.runs()).toHaveLength(2)
  })
  it("revokes unadmitted work, retains admitted work and blocks archived bots", async () => {
    const f = await fixture()
    f.store.accept(f.id, f.hash, "event-1", f.payload, f.payloadHash)
    f.store.configure({
      ...f.change,
      expectedRevision: 1,
      operationId: crypto.randomUUID(),
      hash: null,
    })
    expect(f.routines.runs()[0]?.status).toBe("cancelled")
    rejected(
      () => f.store.accept(f.id, f.hash, "event-2", f.payload, f.payloadHash),
      "unauthorized"
    )
    f.store.configure({
      ...f.change,
      expectedRevision: 2,
      operationId: crypto.randomUUID(),
    })
    f.store.accept(f.id, f.hash, "event-2", f.payload, f.payloadHash)
    f.routines.deliver(() => {})
    f.store.configure({
      ...f.change,
      expectedRevision: 3,
      operationId: crypto.randomUUID(),
      hash: null,
    })
    expect(f.routines.inFlight()?.status).toBe("queued")
    f.archive()
    expect(f.store.authorized(f.id, f.hash)).toBe(false)
    rejected(
      () =>
        f.store.configure({
          ...f.change,
          expectedRevision: 4,
          operationId: crypto.randomUUID(),
        }),
      "conflict"
    )
  })
  it("does not accept paused routines or expose sibling keys", async () => {
    const f = await fixture(),
      sibling = await fixture()
    expect(sibling.store.authorized(f.id, f.hash)).toBe(false)
    f.routines.setStatus({
      id: f.id,
      operationId: crypto.randomUUID(),
      expectedRevision: 1,
      status: "paused",
    })
    rejected(
      () => f.store.accept(f.id, f.hash, "event-1", f.payload, f.payloadHash),
      "conflict"
    )
    expect(f.routines.nextWake()).toBeUndefined()
  })
  it("commits receipt and run atomically, and preserves the prompt through conversation admission", async () => {
    const f = await fixture(),
      conversations = new ConversationStore(f.db, {
        model: "test",
        thinking: "off",
      })
    f.db.run(
      "CREATE TRIGGER fail_event BEFORE INSERT ON webhook_events BEGIN SELECT RAISE(ABORT,'disk failure'); END"
    )
    expect(() =>
      f.store.accept(f.id, f.hash, "event-1", f.payload, f.payloadHash)
    ).toThrow(WebhookStorageError)
    expect(f.routines.inFlight()).toBeUndefined()
    f.db.run("DROP TRIGGER fail_event")
    f.store.accept(f.id, f.hash, "event-1", f.payload, f.payloadHash)
    f.routines.deliver((run) =>
      conversations.admit({ operationId: run.turnId, text: run.prompt })
    )
    expect(Effect.runSync(conversations.recent())[0]?.text).toContain(
      "untrusted source material"
    )
    expect(Effect.runSync(conversations.recent())[0]?.text).toContain(f.payload)
    expect(f.routines.inFlight()?.deadline).toBeGreaterThan(Date.now())
  })
  it("retains dedup receipts at the limit rather than reopening old event IDs", async () => {
    const f = await fixture()
    for (let i = 0; i < 2000; i++)
      f.db.run(
        "INSERT INTO webhook_events VALUES (?,?,?,?)",
        f.id,
        `old-${i}`,
        f.payloadHash,
        `run-${i}`
      )
    expect(
      f.store.accept(f.id, f.hash, "old-1", f.payload, f.payloadHash)
    ).toEqual({ runId: "run-1", duplicate: true })
    rejected(
      () => f.store.accept(f.id, f.hash, "new", f.payload, f.payloadHash),
      "conflict"
    )
    expect(f.routines.runs()).toHaveLength(0)
  })
})

describe("webhook HTTP boundary", () => {
  function incoming(
    f: Awaited<ReturnType<typeof fixture>>,
    body: string = f.payload,
    key = f.key,
    event = "event-1"
  ) {
    return new Request(
      `https://agent.internal/api/agent/webhooks/incoming?routine=${f.id}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "x-event-id": event,
        },
        body,
      }
    )
  }
  it.each(["owner", "incoming"])(
    "retains a failed %s request reader cleanup as a defect",
    async (surface) => {
      const f = await fixture()
      const cleanup = new Error("private body cleanup failure")
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(17_000))
        },
        cancel() {
          return Promise.reject(cleanup)
        },
      })
      const original = incoming(f)
      const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        headers: original.headers,
        body,
        duplex: "half",
      }
      const request = new Request(original.url, init)
      const exit = await Effect.runPromiseExit(
        surface === "owner"
          ? webhookOwnerRequest(f.store.service, request, "webhooks/configure")
          : webhookIncoming(f.store.service, request, () => Effect.void)
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit))
        expect(exit.cause.reasons).toContainEqual(
          expect.objectContaining({ _tag: "Die", defect: cleanup })
        )
      expect(body.locked).toBe(false)
      expect(f.store.info(f.id).accepted).toBe(0)
      expect(f.routines.runs()).toEqual([])
    }
  )
  it("does not turn a tagged wake defect into a normal webhook rejection", async () => {
    const f = await fixture()
    const defect = new WebhookRejected({
      reason: "unauthorized",
      message: "private wake defect",
    })
    const exit = await Effect.runPromiseExit(
      webhookIncoming(f.store.service, incoming(f), () => Effect.die(defect))
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit))
      expect(exit.cause.reasons).toContainEqual(
        expect.objectContaining({ _tag: "Die", defect })
      )
    expect(f.store.info(f.id).accepted).toBe(0)
    expect(f.routines.runs()).toEqual([])
  })
  it("joins cancellation during the acknowledgement wake and replays one committed event", async () => {
    const f = await fixture(),
      entered = deferred(),
      closing = deferred(),
      controller = new AbortController()
    let wakes = 0
    const wake = () =>
      webhookNative(async () => {
        if (++wakes === 2) {
          entered.resolve()
          await closing.promise
        }
      })
    let settled = false
    const observed = Effect.runPromiseExit(
      webhookIncoming(f.store.service, incoming(f), wake),
      { signal: controller.signal }
    ).then((exit) => {
      settled = true
      return exit
    })
    await entered.promise
    controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(f.store.info(f.id).accepted).toBe(1)
    closing.resolve()
    const exit = await observed
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    const replay = await Effect.runPromise(
      webhookIncoming(f.store.service, incoming(f), () => Effect.void)
    )
    expect(replay.status).toBe(200)
    expect(f.store.info(f.id).accepted).toBe(1)
    expect(f.routines.runs()).toHaveLength(1)
  })
  it("returns safe status codes and retries after a lost acknowledgement", async () => {
    const f = await fixture(),
      wake = vi.fn(async () => {})
    wake
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("provider secret must not surface"))
    const first = await Effect.runPromise(
      webhookIncoming(f.store.service, incoming(f), () => webhookNative(wake))
    )
    expect(first.status).toBe(503)
    expect(await first.text()).not.toContain("provider secret")
    const retried = await Effect.runPromise(
      webhookIncoming(f.store.service, incoming(f), () => webhookNative(wake))
    )
    expect(retried.status).toBe(200)
    expect(f.routines.runs()).toHaveLength(1)
    const busy = await Effect.runPromise(
      webhookIncoming(
        f.store.service,
        incoming(f, f.payload, f.key, "event-2"),
        () => webhookNative(wake)
      )
    )
    expect(busy.status).toBe(429)
    expect(busy.headers.get("retry-after")).toBe("60")
  })
  it("rechecks revocation after async wake and rejects malformed or oversized payloads", async () => {
    const f = await fixture()
    for (const body of [
      "{bad",
      "[]",
      "null",
      JSON.stringify({ data: "x".repeat(17000) }),
    ])
      expect(
        (
          await Effect.runPromise(
            webhookIncoming(
              f.store.service,
              incoming(f, body),
              () => Effect.void
            )
          )
        ).status
      ).toBe(400)
    const revoked = await Effect.runPromise(
      webhookIncoming(f.store.service, incoming(f), () =>
        Effect.sync(() => {
          f.store.configure({
            ...f.change,
            operationId: crypto.randomUUID(),
            expectedRevision: 1,
            hash: null,
          })
        })
      )
    )
    expect(revoked.status).toBe(401)
    expect(f.routines.runs()).toHaveLength(0)
  })
  it("supports full bounded instructions plus payload without corrupting run records", async () => {
    const f = await fixture()
    f.routines.save({
      id: f.id,
      operationId: crypto.randomUUID(),
      expectedRevision: 1,
      title: "Long instructions",
      prompt: "x".repeat(12000),
      schedule: { type: "webhook" },
      status: "active",
    })
    const result = await Effect.runPromise(
      webhookIncoming(
        f.store.service,
        incoming(f, JSON.stringify({ data: "y".repeat(16360) })),
        () => Effect.void
      )
    )
    expect(result.status).toBe(202)
    expect(f.routines.runs()[0]!.prompt.length).toBeGreaterThan(28000)
    expect(f.routines.runs()[0]!.prompt.length).toBeLessThan(29000)
  })
  it("rejects normalized numeric expansion without accepting or corrupting a run", async () => {
    const f = await fixture()
    const body = '{"values":[' + Array(3000).fill("1e20").join(",") + "]}"
    expect(body.length).toBeLessThan(16384)
    const result = await Effect.runPromise(
      webhookIncoming(f.store.service, incoming(f, body), () => Effect.void)
    )
    expect(result.status).toBe(413)
    expect(f.routines.inFlight()).toBeUndefined()
    expect(f.routines.runs()).toHaveLength(0)
    expect(f.routines.nextWake()).toBeUndefined()
    expect(f.store.info(f.id).accepted).toBe(0)
  })
  it("returns retryable 503 for transient storage failure and accepts the same event after recovery", async () => {
    const f = await fixture()
    f.db.run(
      "CREATE TRIGGER fail_event BEFORE INSERT ON webhook_events BEGIN SELECT RAISE(ABORT,'private database detail'); END"
    )
    const result = await Effect.runPromise(
      webhookIncoming(f.store.service, incoming(f), () => Effect.void)
    )
    expect(result.status).toBe(503)
    expect(await result.text()).not.toContain("private database detail")
    expect(f.store.info(f.id).accepted).toBe(0)
    expect(f.routines.runs()).toHaveLength(0)
    f.db.run("DROP TRIGGER fail_event")
    expect(
      (
        await Effect.runPromise(
          webhookIncoming(f.store.service, incoming(f), () => Effect.void)
        )
      ).status
    ).toBe(202)
  })
  it("owner configuration responses and durable receipts omit raw keys", async () => {
    const f = await fixture()
    const request = new Request(
      "https://agent.internal/api/agent/webhooks/configure",
      {
        method: "POST",
        body: JSON.stringify({
          routineId: f.id,
          operationId: crypto.randomUUID(),
          expectedRevision: 1,
          key: f.key,
        }),
      }
    )
    const result = await Effect.runPromise(
      webhookOwnerRequest(f.store.service, request, "webhooks/configure")
    )
    expect(result.status).toBe(200)
    expect(await result.text()).not.toContain(f.key)
  })
  it("public forwarding selects the configured owner and strips hostile headers and cookies", async () => {
    const f = await fixture(),
      owner = vi.fn(() => Effect.succeed("configured-owner"))
    const fetch = vi.fn(async (request: Request) => {
      expect(request.headers.get("x-owner-id")).toBe("configured-owner")
      expect(request.headers.get("cookie")).toBeNull()
      expect(request.headers.get("x-app-origin")).toBeNull()
      expect(new URL(request.url).pathname).toBe("/api/agent/webhooks/incoming")
      return Response.json({ runId: "safe" }, { status: 202 })
    })
    const env = {
      owner,
      AGENT_SERVICE: { fetch },
    }
    const request = new Request("https://bot.example/api/hooks/home/id", {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.key}`,
        "x-event-id": "evt",
        "content-type": "application/json",
        cookie: "fake session",
        "x-owner-id": "attacker",
        "x-app-origin": "evil",
      },
      body: f.payload,
    })
    const result = await receiveWebhook(request, "home", f.id, env)
    expect(result.status).toBe(202)
    expect(result.headers.get("cache-control")).toBe("no-store")
    expect(owner).toHaveBeenCalledOnce()
    expect(
      (
        await receiveWebhook(
          new Request("https://bot.example", { method: "POST" }),
          "home",
          f.id,
          env
        )
      ).status
    ).toBe(401)
    expect(fetch).toHaveBeenCalledOnce()
  })
})
