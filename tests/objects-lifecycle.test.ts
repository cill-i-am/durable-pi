import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai"
import {
  Harness,
  createRegistry,
  defineDocFamily,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { Cause, Effect, Exit } from "effect"
import { afterEach, expect, it } from "vitest"

import { objectDigest, piObjectLedger } from "../src/objects/adapters/pi"
import type {
  ChangeSource,
  MutationReceipt,
  ObjectMutation,
} from "../src/objects/contracts"
import type { ObjectLedger } from "../src/objects/ledger"
import {
  decideObjectOperation,
  migrateObjectOperation,
  newObjectOperation,
} from "../src/objects/operation.machine"
import { makeWorkingObjects } from "../src/objects/service"

const user: ChangeSource = {
  actor: "user",
  surface: "workbench",
  turnId: null,
  toolCallId: null,
}
const input = (): ObjectMutation => ({
  id: crypto.randomUUID(),
  operationId: crypto.randomUUID(),
  expectedRevision: 0,
  action: { type: "create", title: "Operation fences", notes: "", tasks: [] },
})
const receipt: MutationReceipt = {
  objectId: "00000000-0000-4000-8000-000000000001",
  revision: 1,
  eventId: "00000000-0000-4000-8000-000000000001:1",
}
const LegacyOperation = defineDocFamily({
  checkpointWhen: () => false,
  kind: "working-objects.operation",
  scope: "session",
  family: true,
  version: 1,
  initial: (_: null) => ({
    digest: "",
    cancelled: false as boolean,
    receipt: null as MutationReceipt | null,
  }),
})
const CurrentOperation = defineDocFamily({
  checkpointWhen: () => false,
  kind: "working-objects.operation",
  scope: "session",
  family: true,
  version: 2,
  initial: (_: null) => newObjectOperation(),
})
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "objects-lifecycle-"))
  const path = join(directory, "pi.sqlite")
  const options = { models: createModels(), registry: createRegistry() }
  let harness = await Harness.open(
    await openNodeSqliteStorage(path),
    options,
    ctx
  )
  const ledger = piObjectLedger(async () => harness)
  cleanups.push(async () => {
    await harness.close(ctx)
    await rm(directory, { recursive: true, force: true })
  })
  return {
    get harness() {
      return harness
    },
    ledger,
    objects: makeWorkingObjects(ledger, () => true, objectDigest),
    restart: async () => {
      await harness.close(ctx)
      harness = await Harness.open(
        await openNodeSqliteStorage(path),
        options,
        ctx
      )
    },
  }
}
function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it.each(["open", "applied", "cancelled"] as const)(
  "converts legacy %s control without changing its identity facts",
  (value) => {
    const legacy = {
      digest: value === "applied" ? "exact-digest" : "",
      receipt: value === "applied" ? receipt : null,
      cancelled: value === "cancelled",
    }
    const state = migrateObjectOperation(legacy, 1)
    expect(state).toEqual({
      ...newObjectOperation(),
      value,
      digest: legacy.digest,
      receipt: legacy.receipt,
    })
    expect(legacy).toHaveProperty("cancelled", value === "cancelled")
    expect(state).not.toHaveProperty("cancelled")
    const restored = JSON.parse(JSON.stringify(state))
    if (value === "cancelled")
      expect(() =>
        decideObjectOperation(restored, { type: "INSPECT", digest: "anything" })
      ).toThrow("cancelled")
    else
      expect(
        decideObjectOperation(restored, {
          type: "INSPECT",
          digest: legacy.digest,
        }).result.type
      ).toBe(value === "open" ? "admit" : "replay")
  }
)

it("retains pre-upgrade cancellation fencing and saved versions", () => {
  const saved = {
    ...newObjectOperation(),
    libraryVersion: "6.0.0-alpha.68/1.0.0-alpha.8",
    piVersion: "1.3.0",
    value: "cancelled",
  }
  expect(() =>
    decideObjectOperation(saved, { type: "INSPECT", digest: "same" })
  ).toThrow("cancelled")
  const repeated = decideObjectOperation(saved, { type: "CANCEL" })
  expect(repeated.changed).toBe(false)
  expect(repeated.state).toEqual(saved)
})

it("rejects unknown versions, impossible records, malformed events and illegal commits", () => {
  for (const field of [
    "schemaVersion",
    "workflowVersion",
    "libraryVersion",
    "piVersion",
  ])
    expect(() =>
      decideObjectOperation(
        { ...newObjectOperation(), [field]: "future" },
        { type: "CANCEL" }
      )
    ).toThrow()
  expect(() =>
    migrateObjectOperation({ digest: "", receipt: null, cancelled: false }, 3)
  ).toThrow("Unsupported")
  expect(() =>
    migrateObjectOperation({ digest: "exact", receipt, cancelled: true }, 1)
  ).toThrow()
  expect(() =>
    migrateObjectOperation({ digest: "", receipt, cancelled: false }, 1)
  ).toThrow()
  expect(() =>
    decideObjectOperation(newObjectOperation(), {
      type: "INSPECT",
      digest: 1,
    } as never)
  ).toThrow()
  const cancelled = decideObjectOperation(newObjectOperation(), {
    type: "CANCEL",
  }).state
  expect(() =>
    decideObjectOperation(cancelled, {
      type: "COMMIT",
      digest: "exact",
      receipt,
    })
  ).toThrow()
  const applied = decideObjectOperation(newObjectOperation(), {
    type: "COMMIT",
    digest: "exact",
    receipt,
  }).state
  expect(() =>
    decideObjectOperation(applied, { type: "INSPECT", digest: "different" })
  ).toThrow("another change")
  expect(() =>
    decideObjectOperation(applied, {
      type: "COMMIT",
      digest: "different",
      receipt,
    })
  ).toThrow()
})

it("migrates native cancellation and replay documents in place and retains no-op receipts across restart", async () => {
  const f = await fixture(),
    mutation = input()
  const created = await Effect.runPromise(f.objects.mutate(mutation, user))
  const noOp: ObjectMutation = {
    id: mutation.id,
    operationId: crypto.randomUUID(),
    expectedRevision: 1,
    action: {
      type: "update",
      changes: [{ type: "edit", title: "Operation fences" }],
    },
  }
  const cancelled = input(),
    fingerprint = await Effect.runPromise(
      objectDigest({ input: noOp, source: user })
    )
  await f.harness.commit(async (tx) => {
    const applied = await tx.doc(LegacyOperation, noOp.operationId, null)
    applied.digest = fingerprint
    applied.receipt = created
    ;(await tx.doc(LegacyOperation, cancelled.operationId, null)).cancelled =
      true
  }, ctx)
  await f.restart()
  expect(await Effect.runPromise(f.objects.mutate(noOp, user))).toEqual(created)
  expect(await Effect.runPromise(f.objects.cancel(noOp.operationId))).toEqual({
    applied: true,
  })
  expect(
    await Effect.runPromise(f.objects.cancel(cancelled.operationId))
  ).toEqual({ applied: false })
  expect(
    await Effect.runPromise(
      f.objects.mutate(cancelled, user).pipe(Effect.result)
    )
  ).toMatchObject({ _tag: "Failure", failure: { code: "cancelled" } })
  expect(
    await f.harness.snapshot(CurrentOperation, noOp.operationId, ctx)
  ).toEqual({
    ...newObjectOperation(),
    value: "applied",
    digest: fingerprint,
    receipt: created,
  })
  expect(
    await f.harness.snapshot(CurrentOperation, cancelled.operationId, ctx)
  ).toEqual({ ...newObjectOperation(), value: "cancelled" })
  await f.restart()
  expect(await Effect.runPromise(f.objects.mutate(noOp, user))).toEqual(created)
  expect(
    (await Effect.runPromise(f.objects.read(mutation.id))).events
  ).toHaveLength(1)
  expect((await Effect.runPromise(f.objects.context())).sequence).toBe(1)
})

it("rejects future native document versions without replacing their saved facts", async () => {
  const f = await fixture(),
    operationId = crypto.randomUUID()
  const FutureOperation = defineDocFamily({
    checkpointWhen: () => false,
    kind: "working-objects.operation",
    scope: "session",
    family: true,
    version: 3,
    initial: (_: null) => ({ future: "retained" }),
  })
  await f.harness.commit(async (tx) => {
    await tx.doc(FutureOperation, operationId, null)
  }, ctx)
  expect(
    await Effect.runPromise(f.objects.cancel(operationId).pipe(Effect.result))
  ).toMatchObject({ _tag: "Failure", failure: { code: "unavailable" } })
  expect(await f.harness.snapshot(FutureOperation, operationId, ctx)).toEqual({
    future: "retained",
  })
})

it("lets cancellation win the native commit race and fences the held mutation after restart", async () => {
  const f = await fixture(),
    mutation = input(),
    entered = barrier(),
    release = barrier()
  const ledger: ObjectLedger = {
    ...f.ledger,
    atomic: (change) =>
      f.ledger.atomic((tx) =>
        change({
          ...tx,
          catalog: () =>
            tx.catalog().pipe(
              Effect.tap(() =>
                Effect.promise(async () => {
                  entered.resolve()
                  await release.promise
                })
              )
            ),
        })
      ),
  }
  const objects = makeWorkingObjects(ledger, () => true, objectDigest)
  const cancellation = Effect.runPromise(objects.cancel(mutation.operationId))
  await entered.promise
  const pending = Effect.runPromise(
    f.objects.mutate(mutation, user).pipe(Effect.result)
  )
  release.resolve()
  expect(await cancellation).toEqual({ applied: false })
  expect(await pending).toMatchObject({
    _tag: "Failure",
    failure: { code: "cancelled" },
  })
  await f.restart()
  expect(
    await Effect.runPromise(
      f.objects.mutate(mutation, user).pipe(Effect.result)
    )
  ).toMatchObject({ _tag: "Failure", failure: { code: "cancelled" } })
  expect(await Effect.runPromise(f.objects.list())).toEqual([])
  expect(
    await Effect.runPromise(
      f.ledger.atomic((tx) =>
        tx.catalog().pipe(Effect.map((catalog) => catalog.operations))
      )
    )
  ).toBe(1)
})

it("reports applied when cancellation races a committed mutation whose acknowledgement is still held", async () => {
  const f = await fixture(),
    mutation = input(),
    entered = barrier(),
    release = barrier()
  const commit = f.harness.commit.bind(f.harness)
  let hold = true
  f.harness.commit = async (change, context) => {
    const result = await commit(change, context)
    if (hold) {
      hold = false
      entered.resolve()
      await release.promise
    }
    return result
  }
  const pending = Effect.runPromise(f.objects.mutate(mutation, user))
  await entered.promise
  try {
    expect(
      await Effect.runPromise(f.objects.cancel(mutation.operationId))
    ).toEqual({ applied: true })
  } finally {
    release.resolve()
  }
  const result = await pending
  expect(await Effect.runPromise(f.objects.mutate(mutation, user))).toEqual(
    result
  )
  expect(
    (await Effect.runPromise(f.objects.read(mutation.id))).events
  ).toHaveLength(1)
  expect(
    await Effect.runPromise(
      f.ledger.atomic((tx) =>
        tx.catalog().pipe(Effect.map((catalog) => catalog.operations))
      )
    )
  ).toBe(1)
})

it("rechecks cancellation authority after native reads and rolls back an unauthorized sentinel", async () => {
  const f = await fixture(),
    mutation = input(),
    entered = barrier(),
    release = barrier()
  let writable = true
  const ledger: ObjectLedger = {
    ...f.ledger,
    atomic: (change) =>
      f.ledger.atomic((tx) =>
        change({
          ...tx,
          catalog: () =>
            tx.catalog().pipe(
              Effect.tap(() =>
                Effect.promise(async () => {
                  entered.resolve()
                  await release.promise
                })
              )
            ),
        })
      ),
  }
  const objects = makeWorkingObjects(ledger, () => writable, objectDigest)
  const pending = Effect.runPromise(
    objects.cancel(mutation.operationId).pipe(Effect.result)
  )
  await entered.promise
  writable = false
  release.resolve()
  expect(await pending).toMatchObject({
    _tag: "Failure",
    failure: { code: "read_only" },
  })
  expect(
    await Effect.runPromise(f.objects.mutate(mutation, user))
  ).toMatchObject({ revision: 1 })
})

it("retains a compound late native settlement Cause while preserving the committed receipt", async () => {
  const f = await fixture(),
    mutation = input(),
    entered = barrier(),
    release = barrier(),
    aborted = barrier()
  const commit = f.harness.commit.bind(f.harness),
    cleanup = new Error("native cleanup failed")
  f.harness.commit = async (change, context) => {
    await commit(change, context)
    context.abortSignal?.addEventListener("abort", aborted.resolve, {
      once: true,
    })
    entered.resolve()
    await release.promise
    throw Cause.fromReasons([
      Cause.makeDieReason(cleanup),
      Cause.makeInterruptReason(),
    ])
  }
  const controller = new AbortController()
  let settled = false
  const pending = Effect.runPromiseExit(f.objects.mutate(mutation, user), {
    signal: controller.signal,
  }).then((exit) => {
    settled = true
    return exit
  })
  await entered.promise
  controller.abort()
  await aborted.promise
  expect(settled).toBe(false)
  release.resolve()
  const exit = await pending
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(exit.cause.reasons).toContainEqual(
      expect.objectContaining({ _tag: "Die", defect: cleanup })
    )
  }
  f.harness.commit = commit
  expect(
    await Effect.runPromise(f.objects.cancel(mutation.operationId))
  ).toEqual({ applied: true })
  expect(
    await Effect.runPromise(f.objects.mutate(mutation, user))
  ).toMatchObject({ revision: 1 })
  expect(
    (await Effect.runPromise(f.objects.read(mutation.id))).events
  ).toHaveLength(1)
})

it("keeps exact digest, no-op receipts and duplicate cancellation stable at capacity", async () => {
  const f = await fixture(),
    mutation = input(),
    cancelled = input()
  const [first, duplicate] = await Promise.all([
    Effect.runPromise(f.objects.mutate(mutation, user)),
    Effect.runPromise(f.objects.mutate(mutation, user)),
  ])
  expect(duplicate).toEqual(first)
  const noOp: ObjectMutation = {
    id: mutation.id,
    operationId: crypto.randomUUID(),
    expectedRevision: 1,
    action: {
      type: "update",
      changes: [{ type: "edit", title: "Operation fences" }],
    },
  }
  expect(await Effect.runPromise(f.objects.mutate(noOp, user))).toEqual(first)
  expect(
    await Effect.runPromise(
      f.objects.mutate(noOp, { ...user, surface: "chat" }).pipe(Effect.result)
    )
  ).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } })
  await Effect.runPromise(f.objects.cancel(cancelled.operationId))
  expect(
    await Effect.runPromise(
      f.ledger.atomic((tx) =>
        tx.catalog().pipe(Effect.map((catalog) => catalog.operations))
      )
    )
  ).toBe(3)
  await Effect.runPromise(
    f.ledger.atomic((tx) =>
      tx.catalog().pipe(
        Effect.map((catalog) => {
          catalog.operations = 20_000
        })
      )
    )
  )
  expect(await Effect.runPromise(f.objects.mutate(mutation, user))).toEqual(
    first
  )
  expect(await Effect.runPromise(f.objects.mutate(noOp, user))).toEqual(first)
  expect(
    await Effect.runPromise(f.objects.cancel(cancelled.operationId))
  ).toEqual({ applied: false })
  expect(
    await Effect.runPromise(f.objects.cancel(mutation.operationId))
  ).toEqual({ applied: true })
  expect(
    await Effect.runPromise(
      f.ledger.atomic((tx) =>
        tx.catalog().pipe(Effect.map((catalog) => catalog.operations))
      )
    )
  ).toBe(20_000)
  expect(
    (await Effect.runPromise(f.objects.read(mutation.id))).events
  ).toHaveLength(1)
  await f.restart()
  expect(await Effect.runPromise(f.objects.mutate(noOp, user))).toEqual(first)
  expect(
    await Effect.runPromise(f.objects.cancel(cancelled.operationId))
  ).toEqual({ applied: false })
})

it.each([
  "schemaVersion",
  "workflowVersion",
  "libraryVersion",
  "piVersion",
] as const)(
  "retains incompatible current-document %s metadata with recovery instructions",
  async (field) => {
    const f = await fixture(),
      mutation = input()
    await Effect.runPromise(f.objects.mutate(mutation, user))
    const RawOperation = defineDocFamily({
      checkpointWhen: () => false,
      kind: "working-objects.operation",
      scope: "session",
      family: true,
      version: 2,
      initial: (_: null): Record<string, string | number> => ({}),
    })
    const future =
      field === "schemaVersion" || field === "workflowVersion" ? 99 : "future"
    await f.harness.commit(async (tx) => {
      const doc = await tx.doc(RawOperation, mutation.operationId, null)
      doc[field] = future
    }, ctx)
    expect(
      await Effect.runPromise(
        f.objects.mutate(mutation, user).pipe(Effect.result)
      )
    ).toMatchObject({
      _tag: "Failure",
      failure: {
        code: "unavailable",
        message: expect.stringContaining("compatible application version"),
      },
    })
    expect(
      (await f.harness.snapshot(RawOperation, mutation.operationId, ctx))?.[
        field
      ]
    ).toBe(future)
    expect(
      (await Effect.runPromise(f.objects.read(mutation.id))).events
    ).toHaveLength(1)
  }
)

it("rejects partially versioned legacy control without dropping its unknown fields", async () => {
  const f = await fixture(),
    operationId = crypto.randomUUID()
  const UnknownLegacy = defineDocFamily({
    checkpointWhen: () => false,
    kind: "working-objects.operation",
    scope: "session",
    family: true,
    version: 1,
    initial: (_: null) => ({
      digest: "",
      receipt: null,
      cancelled: false,
      workflowVersion: 99,
    }),
  })
  await f.harness.commit(async (tx) => {
    await tx.doc(UnknownLegacy, operationId, null)
  }, ctx)
  const exit = await Effect.runPromiseExit(f.objects.cancel(operationId))
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(await f.harness.snapshot(UnknownLegacy, operationId, ctx)).toEqual({
    digest: "",
    receipt: null,
    cancelled: false,
    workflowVersion: 99,
  })
})
