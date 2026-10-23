import { Cause, Effect, Layer, ManagedRuntime } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import { PersonalAgent } from "../src/agent/worker"
import { conversationPump } from "../src/conversations/pump"
import { BackupRecoveryChanged } from "../src/memory/adapters/backup-lifecycle"
import { SqliteBackupStatus } from "../src/memory/adapters/backup-status"
import { SummaryRecoveryChanged } from "../src/memory/adapters/summary-lifecycle"
import { backupStatusApplication } from "../src/memory/backup-status"
import { conversationFixture } from "./conversation-fixture"
import { database } from "./database"

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  RpcTarget: class {},
  env: {},
  tracing: undefined,
}))
vi.mock("agents/lifecycle", () => ({
  Lifecycle: class {},
  LifecycleCapability: class {},
}))
vi.mock("agents/harness/pi", () => ({ PiHarness: class {} }))
const runtimes: { dispose: () => Promise<void> }[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
})
function fixture() {
  const actorRuntime = ManagedRuntime.make(Layer.empty)
  runtimes.push(actorRuntime)
  const pump = Effect.runSync(conversationFixture())
  const host: PersonalAgent = Object.create(PersonalAgent.prototype)
  const armRecovery = vi.fn(async (_epoch: string) => 12345)
  const retryRecovery = vi.fn(async (_epoch: string, _deadline: number) => true)
  const notifyConversation = vi.fn()
  Object.assign(host, {
    actorRuntime,
    conversationPump: conversationPump(
      pump.conversations,
      pump.memory,
      pump.journal,
      pump.execution,
      pump.host
    ),
    familyAdmission: async () => ({
      owner: "fixture",
      modelOwner: "fixture",
      joinedAt: 1,
    }),
    lifecycle: { start: async () => {} },
    ctx: { waitUntil: vi.fn(), id: { toString: () => "actor-id" } },
    compactor: { armRecovery, retryRecovery },
    notifyConversation,
  })
  return { host, armRecovery, retryRecovery, notifyConversation }
}
const request = (epoch = "failed-epoch") =>
  new Request("https://internal/api/agent/memory/retry_compaction", {
    method: "POST",
    body: JSON.stringify({ epoch }),
  })
it("accepts authenticated exact-epoch scheduler recovery using its actual prearmed deadline", async () => {
  const f = fixture()
  const response = await f.host.fetch(request())
  expect(response.status).toBe(202)
  expect(await response.json()).toEqual({ ok: true })
  expect(f.armRecovery).toHaveBeenCalledWith("failed-epoch")
  expect(f.retryRecovery).toHaveBeenCalledWith("failed-epoch", 12345)
  expect(f.notifyConversation).toHaveBeenCalledTimes(1)
})
it("keeps stale prearm and stale final commit distinct from accepted recovery", async () => {
  const f = fixture()
  f.armRecovery.mockRejectedValueOnce(new SummaryRecoveryChanged("refresh"))
  expect((await f.host.fetch(request())).status).toBe(409)
  expect(f.retryRecovery).not.toHaveBeenCalled()
  f.retryRecovery.mockResolvedValueOnce(false)
  expect((await f.host.fetch(request())).status).toBe(409)
  expect(f.notifyConversation).not.toHaveBeenCalled()
})
it("rejects ended family access before prearming scheduler recovery", async () => {
  const f = fixture()
  Object.assign(f.host, { familyAdmission: async () => undefined })
  expect((await f.host.fetch(request())).status).toBe(403)
  expect(f.armRecovery).not.toHaveBeenCalled()
})
it("preserves a compound failure through the actual scheduler recovery route", async () => {
  const f = fixture(),
    defect = new Error("late native recovery defect")
  f.retryRecovery.mockRejectedValueOnce(
    Cause.fromReasons([
      Cause.makeFailReason("storage unavailable"),
      Cause.makeDieReason(defect),
    ])
  )
  await expect(f.host.fetch(request())).rejects.toSatisfy(
    (cause: unknown) =>
      Cause.isCause(cause) &&
      cause.reasons.some(
        (reason) => reason._tag === "Die" && reason.defect === defect
      )
  )
  expect(f.notifyConversation).not.toHaveBeenCalled()
})

it("accepts an exact backup scheduler epoch and preserves changed recovery as409", async () => {
  const f = fixture(),
    lease = { deadline: Date.now() + 60_000, current: () => true }
  const armSchedulerRecovery = vi.fn(async (_epoch: string) => lease)
  const retrySchedulerRecovery = vi.fn(
    async (_epoch: string, _lease: typeof lease) => true
  )
  Object.assign(f.host, {
    backups: { armSchedulerRecovery, retrySchedulerRecovery },
  })
  const request = () =>
    new Request("https://internal/api/agent/memory/backup/recover", {
      method: "POST",
      body: JSON.stringify({ epoch: "backup-epoch" }),
    })
  expect((await f.host.fetch(request())).status).toBe(202)
  expect(retrySchedulerRecovery).toHaveBeenCalledWith("backup-epoch", lease)
  armSchedulerRecovery.mockRejectedValueOnce(
    new BackupRecoveryChanged("newer failure")
  )
  expect((await f.host.fetch(request())).status).toBe(409)
  retrySchedulerRecovery.mockResolvedValueOnce(false)
  expect((await f.host.fetch(request())).status).toBe(409)
  expect(f.notifyConversation).toHaveBeenCalledTimes(1)
})
it("routes an exact backup receipt through the real SQLite retry transaction and retains newer failure", async () => {
  const f = fixture(),
    ledger = new SqliteBackupStatus(database())
  const runtime = ManagedRuntime.make(backupStatusApplication(ledger))
  runtimes.push(runtime)
  Object.assign(f.host, { actorRuntime: runtime })
  await Effect.runPromise(
    ledger.transition({
      type: "ADMIT",
      target: "watermark",
      attemptId: "old",
      now: Date.now(),
    })
  )
  await Effect.runPromise(
    ledger.transition({
      type: "FAILURE",
      attemptId: "old",
      retryable: false,
      now: Date.now(),
    })
  )
  const wake = vi.fn(async () => {})
  Object.assign(f.host, {
    backups: {
      armRecovery: async () => ({
        deadline: Date.now() + 60_000,
        current: () => true,
      }),
      wake,
    },
  })
  const request = () =>
    new Request("https://internal/api/agent/memory/backup/retry", {
      method: "POST",
      body: JSON.stringify({ attemptId: "old", target: "watermark" }),
    })
  expect((await f.host.fetch(request())).status).toBe(202)
  expect(await Effect.runPromise(ledger.control())).toMatchObject({
    phase: "pending",
    attempts: 0,
    attemptId: null,
  })
  expect(wake).toHaveBeenCalledTimes(1)
  await Effect.runPromise(
    ledger.transition({
      type: "ADMIT",
      target: "watermark",
      attemptId: "new",
      now: Date.now(),
    })
  )
  await Effect.runPromise(
    ledger.transition({
      type: "FAILURE",
      attemptId: "new",
      retryable: false,
      now: Date.now(),
    })
  )
  expect((await f.host.fetch(request())).status).toBe(409)
  expect(await Effect.runPromise(ledger.control())).toMatchObject({
    phase: "failed",
    attemptId: "new",
    attempts: 1,
  })
  expect(wake).toHaveBeenCalledTimes(1)
})
it("does not reset backup state when its discovery lease is stale or a producer is still running", async () => {
  const f = fixture(),
    ledger = new SqliteBackupStatus(database())
  const runtime = ManagedRuntime.make(backupStatusApplication(ledger))
  runtimes.push(runtime)
  Object.assign(f.host, { actorRuntime: runtime })
  await Effect.runPromise(
    ledger.transition({
      type: "ADMIT",
      target: "watermark",
      attemptId: "owner",
      now: Date.now(),
    })
  )
  await Effect.runPromise(
    ledger.transition({
      type: "FAILURE",
      attemptId: "owner",
      retryable: false,
      now: Date.now(),
    })
  )
  const before = await Effect.runPromise(ledger.control()),
    wake = vi.fn(async () => {})
  const armRecovery = vi.fn(async () => ({
    deadline: Date.now() + 60_000,
    current: () => false,
  }))
  Object.assign(f.host, { backups: { armRecovery, wake } })
  const request = () =>
    new Request("https://internal/api/agent/memory/backup/retry", {
      method: "POST",
      body: JSON.stringify({ attemptId: "owner", target: "watermark" }),
    })
  expect((await f.host.fetch(request())).status).toBe(409)
  expect(await Effect.runPromise(ledger.control())).toEqual(before)
  armRecovery.mockRejectedValueOnce(new BackupRecoveryChanged("still running"))
  expect((await f.host.fetch(request())).status).toBe(409)
  expect(wake).not.toHaveBeenCalled()
})
