import { Clock, Cause, Effect, Exit } from "effect"
import { describe, expect, it, vi } from "vitest"

import { fatalCause } from "../src/shared/effect"
import { workspaceNativeOperation } from "../src/workspace/adapters/interop"
import {
  r2WorkspaceAssets,
  type AssetBucket,
} from "../src/workspace/adapters/r2"
import { SqliteWorkspace } from "../src/workspace/adapters/sqlite"
import { AudioUnreadable } from "../src/workspace/audio"
import { DocumentUnreadable } from "../src/workspace/documents"
import { WorkspaceUnavailable } from "../src/workspace/files"
import { decidePreparation } from "../src/workspace/preparation.machine"
import { decideReservation } from "../src/workspace/reservation.machine"
import {
  makeWorkspace,
  type WorkspaceProcessing,
} from "../src/workspace/service"
import { database, corrupt } from "./database"

const gate = () => {
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  return { waiting, release }
}
// Store-only finite admission lease. Native alarm survival is a separate host gate.
const arm = () =>
  Clock.currentTimeMillis.pipe(Effect.map((now) => now + 60_000))
const pdf = () => ({
  id: crypto.randomUUID(),
  name: "fixture.pdf",
  mime: "application/pdf",
  bytes: new TextEncoder().encode("%PDF-1.7 synthetic"),
})
const extracted = (text: string) => ({
  text,
  pages: 1,
  readPages: 1,
  truncated: false,
})
const clip = (captions: string) => ({
  duration: 1,
  frames: [{ at: 0, jpeg: btoa(String.fromCharCode(255, 216, 255)) }],
  captions,
  captionsTruncated: false,
})
function fixture() {
  const db = database(),
    objects = new Map<string, Uint8Array>()
  const bucket: AssetBucket = {
    async put(key, bytes) {
      objects.set(key, bytes.slice())
    },
    async get(key) {
      const bytes = objects.get(key)
      return bytes
        ? {
            body: new Blob([new Uint8Array(bytes)]).stream(),
            arrayBuffer: async () => new Uint8Array(bytes).buffer,
          }
        : null
    },
  }
  const assets = r2WorkspaceAssets(bucket, "synthetic-owner")
  const make = (
    processing: Partial<WorkspaceProcessing> = {},
    cold = false
  ) => {
    const ledger = new SqliteWorkspace(db)
    // Model another activation's local occupancy, while retaining one real SQL
    // ledger and an older, already-dispatched synthetic remote write.
    if (cold) Object.defineProperty(ledger, "transactionGroup", { value: {} })
    return makeWorkspace(ledger, assets, () => Effect.succeed(true), {
      arm,
      document: () => Effect.succeed(extracted("older")),
      video: () => Effect.succeed(clip("older")),
      ...processing,
    })
  }
  return { db, objects, bucket, assets, make }
}

it("a warm facade waits for the existing extraction owner instead of stealing its running job", async () => {
  const f = fixture(),
    entered = gate(),
    release = gate(),
    put = f.bucket.put
  let replacements = 0
  f.bucket.put = async (key, bytes) => {
    if (key.endsWith("pdf-text-v1")) {
      entered.release()
      await release.waiting
    }
    return put(key, bytes)
  }
  const old = f.make(),
    warm = f.make({
      document: () =>
        Effect.sync(() => {
          replacements++
          return extracted("replacement")
        }),
    }),
    input = pdf()
  await Effect.runPromise(old.upload(input))
  const first = Effect.runPromise(old.extractNext())
  await entered.waiting
  let settled = false
  const second = Effect.runPromise(warm.extractNext()).then((value) => {
    settled = true
    return value
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(settled).toBe(false)
  expect(replacements).toBe(0)
  expect(
    Effect.runSync(new SqliteWorkspace(f.db).document(input.id))
  ).toMatchObject({ status: "running", attempts: 1 })
  release.release()
  expect(await first).toBe(true)
  expect(await second).toBe(false)
})

it.each(["document", "video"] as const)(
  "%s publication survives an older held put after explicit cold restoration",
  async (kind) => {
    const f = fixture(),
      entered = gate(),
      release = gate(),
      put = f.bucket.put
    const variant = kind === "document" ? "pdf-text-v1" : "video-v1"
    let puts = 0
    f.bucket.put = async (key, bytes) => {
      if (key.endsWith(variant) && ++puts === 1) {
        entered.release()
        await release.waiting
      }
      return put(key, bytes)
    }
    const old = f.make(),
      replacement = f.make(
        {
          document: () => Effect.succeed(extracted("replacement content")),
          video: () => Effect.succeed(clip("replacement content")),
        },
        true
      )
    const input =
      kind === "document"
        ? pdf()
        : {
            id: crypto.randomUUID(),
            name: "clip.mp4",
            mime: "video/mp4",
            bytes: Uint8Array.of(0, 0, 0, 24, 102, 116, 121, 112),
          }
    await Effect.runPromise(old.upload(input))
    const first = Effect.runPromise(old.extractNext())
    await entered.waiting
    try {
      expect(await Effect.runPromise(replacement.extractNext())).toBe(false)
      await Effect.runPromise(replacement.restorePreparation())
      expect(await Effect.runPromise(replacement.extractNext())).toBe(true)
      const ledger = new SqliteWorkspace(f.db)
      expect(
        kind === "document"
          ? Effect.runSync(ledger.document(input.id))
          : Effect.runSync(ledger.video(input.id))
      ).toMatchObject({ status: "ready", attempts: 2 })
    } finally {
      release.release()
    }
    await first
    const served =
      kind === "document"
        ? (await Effect.runPromise(replacement.readText(input.id, 0, 1000)))
            .text
        : (await Effect.runPromise(replacement.video(input.id))).captions
    expect(served).toBe("replacement content")
    expect(
      [...f.objects.keys()].filter((key) => key.endsWith(variant))
    ).toHaveLength(2)
  }
)

it("a retry budget reset cannot authorize the original attempt's late metadata", async () => {
  const f = fixture(),
    entered = gate(),
    release = gate(),
    put = f.bucket.put
  let puts = 0,
    failed = true
  f.bucket.put = async (key, bytes) => {
    if (key.endsWith("pdf-text-v1") && ++puts === 1) {
      entered.release()
      await release.waiting
    }
    return put(key, bytes)
  }
  const old = f.make(),
    replacement = f.make(
      {
        document: () =>
          failed
            ? Effect.fail(new DocumentUnreadable({ reason: "invalid" }))
            : Effect.succeed(extracted("new body with distinct metadata")),
      },
      true
    ),
    input = pdf()
  await Effect.runPromise(old.upload(input))
  const first = Effect.runPromise(old.extractNext())
  await entered.waiting
  try {
    await Effect.runPromise(replacement.restorePreparation())
    await Effect.runPromise(replacement.extractNext())
    await Effect.runPromise(replacement.retryExtraction(input.id))
    failed = false
    await Effect.runPromise(replacement.extractNext())
  } finally {
    release.release()
  }
  await first
  expect(
    Effect.runSync(new SqliteWorkspace(f.db).document(input.id))
  ).toMatchObject({ status: "ready", attempts: 1, characters: 31 })
  expect(
    (await Effect.runPromise(replacement.readText(input.id, 0, 1000))).text
  ).toBe("new body with distinct metadata")
})

it("joins a cancelled decoder's native work and retains late compound failure", async () => {
  const f = fixture(),
    entered = gate(),
    release = gate(),
    abort = new AbortController()
  const workspace = f.make({
    document: () =>
      workspaceNativeOperation(async () => {
        entered.release()
        await release.waiting
        return extracted("late")
      }).pipe(
        Effect.ensuring(
          Effect.failCause(
            fatalCause(
              Cause.combine(
                Cause.fail(new WorkspaceUnavailable()),
                Cause.die("late cleanup defect")
              )
            )
          )
        )
      ),
  })
  const input = pdf()
  await Effect.runPromise(workspace.upload(input))
  let finished = false
  const pending = Effect.runPromiseExit(workspace.extractNext(), {
    signal: abort.signal,
  }).then((value) => {
    finished = true
    return value
  })
  await entered.waiting
  abort.abort()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(finished).toBe(false)
  release.release()
  const exit = await pending
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain(
    "WorkspaceUnavailable"
  )
  expect(
    Effect.runSync(new SqliteWorkspace(f.db).document(input.id))?.status
  ).toBe("running")
  expect(
    [...f.objects.keys()].filter((key) => key.endsWith("pdf-text-v1"))
  ).toHaveLength(0)
})

it("fails closed without discovery and rechecks a lease after entering the publication transaction", async () => {
  const f = fixture(),
    input = pdf(),
    ledger = new SqliteWorkspace(f.db)
  const absent = makeWorkspace(ledger, f.assets, () => Effect.succeed(true))
  await expect(Effect.runPromise(absent.upload(input))).rejects.toMatchObject({
    _tag: "WorkspaceUnavailable",
  })
  expect(f.db.all("SELECT id FROM workspace_files")).toEqual([])
  let now = 1000,
    armed = false
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
  const atomic = ledger.atomic.bind(ledger)
  ledger.atomic = (change) =>
    Effect.suspend(() => {
      if (armed) now += 2000
      return atomic(change)
    })
  try {
    const workspace = makeWorkspace(
      ledger,
      f.assets,
      () => Effect.succeed(true),
      {
        arm: () =>
          Effect.sync(() => {
            armed = true
            return now + 1000
          }),
      }
    )
    await expect(
      Effect.runPromise(workspace.upload(input))
    ).rejects.toMatchObject({ _tag: "WorkspaceUnavailable" })
    expect(f.db.all("SELECT id FROM workspace_extractions")).toEqual([])
    expect(f.db.all("SELECT status FROM workspace_files")).toEqual([
      { status: "uploading" },
    ])
  } finally {
    clock.mockRestore()
  }
})

it("converts legacy records transactionally without recovering a live running attempt on read", async () => {
  const f = fixture(),
    input = pdf(),
    workspace = f.make()
  await Effect.runPromise(workspace.upload(input))
  f.db.run("UPDATE workspace_files SET lifecycle_version=0")
  f.db.run(
    "UPDATE workspace_extractions SET lifecycle_version=0,status='running',attempts=2"
  )
  const ledger = new SqliteWorkspace(f.db)
  const before = f.db.all("SELECT id,hash,createdAt FROM workspace_files")
  expect(Effect.runSync(ledger.document(input.id))).toMatchObject({
    lifecycleVersion: 1,
    status: "running",
    attempts: 2,
  })
  expect(Effect.runSync(ledger.read(input.id))).toMatchObject({
    lifecycleVersion: 1,
  })
  expect(f.db.all("SELECT id,hash,createdAt FROM workspace_files")).toEqual(
    before
  )
  expect(await Effect.runPromise(workspace.extractNext())).toBe(false)
  await Effect.runPromise(workspace.restorePreparation())
  expect(Effect.runSync(ledger.document(input.id))).toMatchObject({
    status: "pending",
    attempts: 2,
  })
  corrupt(f.db, "UPDATE workspace_extractions SET lifecycle_version=99")
  const exit = await Effect.runPromiseExit(ledger.document(input.id))
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
})

describe("Workspace pure lifecycle decisions", () => {
  it("rejects malformed events, future versions and stale ownership while retaining three attempts", () => {
    const pending = {
      status: "pending" as const,
      attempts: 0,
      error: null,
      recoveryDeadline: 600_000,
    }
    let running = decidePreparation(pending, {
      type: "CLAIM",
      attemptId: "a",
      now: 0,
    })
    expect(running).toMatchObject({ status: "running", attempts: 1 })
    expect(
      decidePreparation(running, {
        type: "COMPLETE",
        attemptId: "old",
        artifactHash: "old",
        empty: false,
        error: null,
      })
    ).toEqual(running)
    for (let attempt = 1; attempt <= 3; attempt++) {
      const restored = decidePreparation(running, { type: "RESTORE" })
      expect(restored.status).toBe(attempt < 3 ? "pending" : "failed")
      if (attempt < 3)
        running = decidePreparation(restored, {
          type: "CLAIM",
          attemptId: `attempt-${attempt + 1}`,
          now: 0,
        })
    }
    const failed = decidePreparation(running, { type: "RESTORE" })
    expect(
      decidePreparation(failed, { type: "CLAIM", attemptId: "denied", now: 0 })
        .attempts
    ).toBe(3)
    expect(decidePreparation(failed, { type: "RETRY", now: 0 })).toMatchObject({
      status: "pending",
      attempts: 0,
      attemptId: null,
    })
    expect(() =>
      decidePreparation(
        { ...pending, lifecycleVersion: 2 },
        { type: "RETRY", now: 0 }
      )
    ).toThrow()
    expect(() =>
      decidePreparation(pending, {
        type: "CLAIM",
        attemptId: 7,
        now: 0,
      } as never)
    ).toThrow()
    const reserved = decideReservation(
      { status: "uploading" },
      { type: "CLAIM", attemptId: "new" }
    )
    expect(
      decideReservation(reserved, { type: "READY", attemptId: "old" }).status
    ).toBe("uploading")
    expect(
      decideReservation(reserved, { type: "READY", attemptId: "new" }).status
    ).toBe("ready")
  })
})

it("shares upload occupancy across warm facades through cancellation and joined native cleanup", async () => {
  const f = fixture(),
    entered = gate(),
    release = gate(),
    put = f.bucket.put
  let writes = 0,
    active = 0,
    maximum = 0
  f.bucket.put = async (key, bytes) => {
    active++
    maximum = Math.max(maximum, active)
    try {
      if (++writes === 1) {
        entered.release()
        await release.waiting
      }
      await put(key, bytes)
    } finally {
      active--
    }
  }
  const old = f.make(),
    warm = f.make(),
    input = {
      ...pdf(),
      name: "note.txt",
      mime: "text/plain",
      bytes: new TextEncoder().encode("immutable input"),
    },
    abort = new AbortController()
  const first = Effect.runPromiseExit(old.upload(input), {
    signal: abort.signal,
  })
  await entered.waiting
  abort.abort()
  const replay = Effect.runPromise(warm.upload(input))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(writes).toBe(1)
  release.release()
  expect(Exit.isFailure(await first)).toBe(true)
  expect(await replay).toMatchObject({ status: "ready" })
  expect(maximum).toBe(1)
  expect(writes).toBe(2)
})

it("checks exhausted runner eligibility inside its SQL transaction and preserves newer claims", async () => {
  const f = fixture(),
    ledger = new SqliteWorkspace(f.db),
    input = pdf()
  const workspace = makeWorkspace(
    ledger,
    f.assets,
    () => Effect.succeed(true),
    { arm, document: () => Effect.fail(new WorkspaceUnavailable()) }
  )
  await Effect.runPromise(workspace.upload(input))
  let claim: import("../src/workspace/workspace").PreparationClaim | undefined
  await Effect.runPromise(
    workspace.extractNext((value) =>
      Effect.sync(() => {
        claim = value
      })
    )
  )
  expect(claim).toMatchObject({ attempts: 1 })
  const atomic = ledger.atomic.bind(ledger)
  let eligible = true
  ledger.atomic = (change) =>
    Effect.suspend(() => {
      eligible = false
      return atomic(change)
    })
  await Effect.runPromise(workspace.exhaustPreparation(claim!, () => eligible))
  expect(
    Effect.runSync(new SqliteWorkspace(f.db).document(input.id))?.status
  ).toBe("pending")
  ledger.atomic = atomic
  await Effect.runPromise(
    workspace.exhaustPreparation({ ...claim!, attemptId: "stale" })
  )
  expect(Effect.runSync(ledger.document(input.id))?.status).toBe("pending")
  await Effect.runPromise(workspace.exhaustPreparation(claim!))
  expect(Effect.runSync(ledger.document(input.id))).toMatchObject({
    status: "failed",
    attempts: 1,
  })
})

it("rolls legacy conversion back when its version write is not acknowledged", async () => {
  const f = fixture(),
    workspace = f.make(),
    input = pdf()
  await Effect.runPromise(workspace.upload(input))
  f.db.run("UPDATE workspace_extractions SET lifecycle_version=0")
  f.db.run(
    "CREATE TRIGGER reject_conversion BEFORE UPDATE OF lifecycle_version ON workspace_extractions BEGIN SELECT RAISE(ABORT,'unacknowledged conversion'); END"
  )
  await expect(
    Effect.runPromise(new SqliteWorkspace(f.db).document(input.id))
  ).rejects.toMatchObject({ _tag: "WorkspaceUnavailable" })
  expect(
    f.db.all(
      "SELECT lifecycle_version,status,attempts FROM workspace_extractions"
    )
  ).toEqual([{ lifecycle_version: 0, status: "pending", attempts: 0 }])
})

it("replays ready content and rejects conflicting identities before discovery, while legacy promotion still requires it", async () => {
  const f = fixture(),
    input = pdf(),
    first = f.make()
  await Effect.runPromise(first.upload(input))
  let arms = 0
  const workspace = f.make({
    arm: () =>
      Effect.suspend(() => {
        arms++
        return Effect.fail(new WorkspaceUnavailable())
      }),
  })
  expect(await Effect.runPromise(workspace.upload(input))).toMatchObject({
    status: "ready",
  })
  await expect(
    Effect.runPromise(
      workspace.upload({
        ...input,
        bytes: new TextEncoder().encode("%PDF-different"),
      })
    )
  ).rejects.toMatchObject({ _tag: "FileRejected" })
  expect(arms).toBe(0)
  f.db.run("DELETE FROM workspace_extractions")
  f.db.run(
    "UPDATE workspace_files SET mime='application/octet-stream',lifecycle_version=0"
  )
  await expect(
    Effect.runPromise(workspace.upload(input))
  ).rejects.toMatchObject({ _tag: "WorkspaceUnavailable" })
  expect(arms).toBe(1)
  expect(f.db.all("SELECT mime FROM workspace_files")).toEqual([
    { mime: "application/octet-stream" },
  ])
  const expired = f.make({ arm: () => Clock.currentTimeMillis })
  await expect(Effect.runPromise(expired.upload(input))).rejects.toMatchObject({
    _tag: "WorkspaceUnavailable",
  })
  expect(f.db.all("SELECT id FROM workspace_extractions")).toEqual([])
  expect(f.db.all("SELECT mime FROM workspace_files")).toEqual([
    { mime: "application/octet-stream" },
  ])
  expect(await Effect.runPromise(first.upload(input))).toMatchObject({
    mime: "application/pdf",
    extraction: { status: "pending" },
  })
})

it("retains an exhausted unclaimed pump until the finite pending deadline, without failing fresh work", async () => {
  const f = fixture(),
    workspace = f.make(),
    input = pdf()
  let now = 1_000
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
  try {
    await Effect.runPromise(workspace.upload(input))
    const deadline = Effect.runSync(
      new SqliteWorkspace(f.db).document(input.id)
    )!.recoveryDeadline!
    expect(deadline).toBe(601_000)
    expect(
      await Effect.runPromise(workspace.exhaustPreparation(undefined))
    ).toBe(deadline)
    now += 120_000
    expect(await Effect.runPromise(workspace.list())).toMatchObject([
      { extraction: { status: "pending" } },
    ])
    expect(
      Effect.runSync(new SqliteWorkspace(f.db).document(input.id))!
        .recoveryDeadline
    ).toBe(deadline)
    now = deadline
    expect(
      await Effect.runPromise(workspace.exhaustPreparation(undefined))
    ).toBeUndefined()
    expect(await Effect.runPromise(workspace.list())).toMatchObject([
      {
        extraction: {
          status: "failed",
          error: "Preparation recovery expired. Retry from Files.",
        },
      },
    ])
    await Effect.runPromise(workspace.retryExtraction(input.id))
    expect(
      Effect.runSync(new SqliteWorkspace(f.db).document(input.id))
    ).toMatchObject({
      status: "pending",
      attempts: 0,
      recoveryDeadline: deadline + 600_000,
    })
  } finally {
    clock.mockRestore()
  }
})

it("status detects expired pending work after a failed exhaustion commit and never expires a live running owner", async () => {
  const f = fixture(),
    workspace = f.make(),
    pending = pdf(),
    running = pdf()
  let now = 1_000
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
  try {
    await Effect.runPromise(workspace.upload(pending))
    await Effect.runPromise(workspace.upload(running))
    f.db.run(
      "UPDATE workspace_extractions SET status='running',attempts=1,attempt_id='live' WHERE id=?",
      running.id
    )
    now = 601_000
    f.db.run(
      "CREATE TRIGGER reject_expiry BEFORE UPDATE OF status ON workspace_extractions BEGIN SELECT RAISE(ABORT,'unacknowledged expiry'); END"
    )
    await expect(
      Effect.runPromise(workspace.exhaustPreparation(undefined))
    ).rejects.toMatchObject({ _tag: "WorkspaceUnavailable" })
    f.db.run("DROP TRIGGER reject_expiry")
    const rows = await Effect.runPromise(workspace.list())
    expect(
      rows.find((file) => file.id === pending.id)?.extraction?.status
    ).toBe("failed")
    expect(
      rows.find((file) => file.id === running.id)?.extraction?.status
    ).toBe("running")
    await Effect.runPromise(workspace.restorePreparation())
    expect(
      Effect.runSync(new SqliteWorkspace(f.db).document(running.id))
    ).toMatchObject({ status: "failed", attempts: 1 })
  } finally {
    clock.mockRestore()
  }
})

it("an overdue live native owner remains running until its failed scope joins, even if exact exhaustion cannot commit", async () => {
  const f = fixture(),
    input = pdf(),
    entered = gate(),
    release = gate()
  let now = 1_000
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
  const workspace = f.make({
    document: () =>
      workspaceNativeOperation(async () => {
        entered.release()
        await release.waiting
        return extracted("late")
      }).pipe(Effect.andThen(Effect.die("decoder finalization failed"))),
  })
  let claim: import("../src/workspace/workspace").PreparationClaim | undefined
  try {
    await Effect.runPromise(workspace.upload(input))
    const running = Effect.runPromiseExit(
      workspace.extractNext((value) =>
        Effect.sync(() => {
          claim = value
        })
      )
    )
    await entered.waiting
    now = 601_000
    expect(
      (await Effect.runPromise(workspace.list()))[0]?.extraction?.status
    ).toBe("running")
    expect(
      await Effect.runPromise(f.make().nextPreparationWake())
    ).toBeUndefined()
    release.release()
    const exit = await running
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    f.db.run(
      "CREATE TRIGGER reject_final_exhaust BEFORE UPDATE OF status ON workspace_extractions BEGIN SELECT RAISE(ABORT,'unacknowledged failure'); END"
    )
    await expect(
      Effect.runPromise(workspace.exhaustPreparation(claim!))
    ).rejects.toMatchObject({ _tag: "WorkspaceUnavailable" })
    expect(f.db.all("SELECT status FROM workspace_extractions")).toEqual([
      { status: "running" },
    ])
    f.db.run("DROP TRIGGER reject_final_exhaust")
    // A warm facade shares the positive joined-token evidence. It can retire
    // this exact attempt but cannot authorize another decoder invocation.
    expect(
      (await Effect.runPromise(f.make().list()))[0]?.extraction?.status
    ).toBe("failed")
    expect(await Effect.runPromise(f.make().extractNext())).toBe(false)
  } finally {
    release.release()
    clock.mockRestore()
  }
})

it("preserves audio decoding plus cleanup failure instead of materializing a normal file rejection", async () => {
  const f = fixture(),
    cleanup = new Error("audio cleanup defect")
  const workspace = f.make({
    audio: () =>
      Effect.fail(new AudioUnreadable({ message: "unreadable audio" })).pipe(
        Effect.ensuring(Effect.die(cleanup))
      ),
  })
  const exit = await Effect.runPromiseExit(
    workspace.upload({
      id: crypto.randomUUID(),
      name: "voice.ogg",
      mime: "audio/ogg",
      bytes: new TextEncoder().encode("OggS synthetic voice"),
    })
  )
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(
    Exit.isFailure(exit) &&
      exit.cause.reasons.some(
        (reason) => reason._tag === "Die" && reason.defect === cleanup
      )
  ).toBe(true)
})
