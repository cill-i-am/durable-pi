import { it as effectIt } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Layer, ManagedRuntime } from "effect"
import { TestClock } from "effect/testing"
import { expect, it } from "vitest"

import type { FamilyGeneration, FamilyState } from "../src/agents/family"
import {
  FamilyAdmission,
  familyAdmissionApplication,
} from "../src/agents/family-admission"
import { CredentialUnavailable } from "../src/inference/credentials"

const member: FamilyState = {
  owner: "person",
  modelOwner: "owner",
  joinedAt: 1,
  membershipId: "new-membership",
}
const versioned = (membershipId: string | null): FamilyGeneration => ({
  schemaVersion: 1,
  workflowVersion: 1,
  membershipId,
})
const admit = FamilyAdmission.use((service) => service.admit)
function fixture(initial: unknown, state: FamilyState | null = member) {
  let saved = initial,
    fences = 0,
    writes = 0
  const host = {
    read: () => Effect.succeed(state),
    generation: () => Effect.sync(() => saved),
    write: (record: FamilyGeneration) =>
      Effect.sync(() => {
        writes++
        saved = record
      }),
    fence: () =>
      Effect.sync(() => {
        fences++
      }),
  }
  return {
    host,
    saved: () => saved,
    fences: () => fences,
    writes: () => writes,
    runtime: () => ManagedRuntime.make(familyAdmissionApplication(host)),
  }
}

it.each([undefined, null, "new-membership", versioned("new-membership")])(
  "restores membership %j and converts legacy data without changing identity or repeating cleanup",
  async (saved) => {
    const f = fixture(saved),
      first = f.runtime()
    try {
      expect(await first.runPromise(admit)).toEqual(member)
      expect(f.saved()).toEqual(versioned(member.membershipId))
    } finally {
      await first.dispose()
    }
    const fences = f.fences(),
      writes = f.writes(),
      restarted = f.runtime()
    try {
      expect(await restarted.runPromise(admit)).toEqual(member)
      expect(f.fences()).toBe(fences)
      expect(f.writes()).toBe(writes)
    } finally {
      await restarted.dispose()
    }
  }
)

it.each(["schemaVersion", "workflowVersion"])(
  "rejects unknown %s without mutating membership or cancelling work",
  async (field) => {
    const initial = { ...versioned("old-membership"), [field]: 2 },
      f = fixture(initial),
      runtime = f.runtime()
    try {
      const result = await runtime.runPromiseExit(admit)
      expect(Exit.isFailure(result) && Cause.hasDies(result.cause)).toBe(true)
      expect(f.saved()).toEqual(initial)
      expect(f.fences()).toBe(0)
      expect(f.writes()).toBe(0)
    } finally {
      await runtime.dispose()
    }
  }
)

it("retains a removed membership sentinel across restart and never admits a removed person", async () => {
  const f = fixture("old-membership", null),
    runtime = f.runtime()
  try {
    expect(await runtime.runPromise(admit)).toBeNull()
  } finally {
    await runtime.dispose()
  }
  expect(f.saved()).toEqual(versioned(null))
  expect(f.fences()).toBe(1)
  const restarted = f.runtime()
  try {
    expect(await restarted.runPromise(admit)).toBeNull()
  } finally {
    await restarted.dispose()
  }
  expect(f.fences()).toBe(1)
})

it("caller interruption leaves the shared generation owner running until other admissions can safely proceed", async () => {
  const f = fixture("old-membership")
  const entered = Deferred.makeUnsafe<void>(),
    release = Deferred.makeUnsafe<void>()
  const fence = f.host.fence
  f.host.fence = () =>
    Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.andThen(fence())
    )
  const runtime = f.runtime(),
    controller = new AbortController()
  try {
    const cancelled = runtime.runPromiseExit(admit, {
      signal: controller.signal,
    })
    await Effect.runPromise(Deferred.await(entered))
    controller.abort()
    const result = await cancelled
    expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(
      true
    )
    const next = runtime.runPromise(admit)
    expect(f.saved()).toBe("old-membership")
    await Effect.runPromise(Deferred.succeed(release, undefined))
    expect(await next).toEqual(member)
    expect(f.fences()).toBe(1)
    expect(f.writes()).toBe(1)
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await runtime.dispose()
  }
})

it("host disposal joins fence cleanup and restart retries an uncommitted generation", async () => {
  const f = fixture("old-membership")
  const entered = Deferred.makeUnsafe<void>(),
    closing = Deferred.makeUnsafe<void>(),
    release = Deferred.makeUnsafe<void>()
  const events: string[] = []
  const runtime = ManagedRuntime.make(
    familyAdmissionApplication({
      ...f.host,
      fence: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Deferred.succeed(closing, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(
                Effect.sync(() => {
                  events.push("fence.cleaned")
                })
              )
            )
          )
        ),
    }).pipe(
      Layer.provide(
        Layer.effectDiscard(
          Effect.addFinalizer(() =>
            Effect.sync(() => {
              events.push("dependency.closed")
            })
          )
        )
      )
    )
  )
  const pending = runtime.runPromiseExit(admit)
  await Effect.runPromise(Deferred.await(entered))
  let closed = false
  const disposal = runtime.dispose().then(() => {
    closed = true
  })
  await Effect.runPromise(Deferred.await(closing))
  expect(closed).toBe(false)
  expect(events).toEqual([])
  expect(f.saved()).toBe("old-membership")
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await disposal
  await pending
  expect(events).toEqual(["fence.cleaned", "dependency.closed"])
  expect(f.writes()).toBe(0)
  const restarted = f.runtime()
  try {
    expect(await restarted.runPromise(admit)).toEqual(member)
  } finally {
    await restarted.dispose()
  }
  expect(f.fences()).toBe(1)
})

it("keeps the old generation after a failed checkpoint and retries without admitting new work first", async () => {
  const f = fixture("old-membership"),
    write = f.host.write
  let fail = true
  f.host.write = (record) =>
    fail ? Effect.die(new Error("checkpoint unavailable")) : write(record)
  const runtime = f.runtime()
  try {
    await expect(runtime.runPromise(admit)).rejects.toThrow(
      "checkpoint unavailable"
    )
    expect(f.saved()).toBe("old-membership")
    expect(f.fences()).toBe(1)
    fail = false
    expect(await runtime.runPromise(admit)).toEqual(member)
    expect(f.fences()).toBe(2)
    expect(f.writes()).toBe(1)
  } finally {
    await runtime.dispose()
  }
})

it("preserves compound typed failures and defects from generation cleanup", async () => {
  const f = fixture("old-membership")
  const runtime = ManagedRuntime.make(
    familyAdmissionApplication({
      ...f.host,
      fence: () =>
        Effect.failCause(
          Cause.combine(
            Cause.fail(
              new CredentialUnavailable({ message: "revocation unavailable" })
            ),
            Cause.die(new Error("cleanup defect"))
          )
        ),
    })
  )
  try {
    const result = await runtime.runPromiseExit(admit)
    expect(Exit.isFailure(result) && Cause.hasFails(result.cause)).toBe(true)
    expect(Exit.isFailure(result) && Cause.hasDies(result.cause)).toBe(true)
    expect(f.saved()).toBe("old-membership")
  } finally {
    await runtime.dispose()
  }
})

it("binds admission receipts to the generation owner before asynchronous revocation cleanup", async () => {
  const f = fixture(versioned(member.membershipId)),
    runtime = f.runtime(),
    entered = Deferred.makeUnsafe<void>(),
    release = Deferred.makeUnsafe<void>()
  f.host.fence = () =>
    Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(release))
    )
  try {
    const receipt = await runtime.runPromise(
      FamilyAdmission.use((service) => service.receipt)
    )
    expect(receipt?.current()).toBe(true)
    f.host.read = () => Effect.succeed(null)
    const removed = runtime.runPromise(admit)
    await Effect.runPromise(Deferred.await(entered))
    expect(receipt?.current()).toBe(false)
    expect(f.saved()).toEqual(versioned(member.membershipId))
    await Effect.runPromise(Deferred.succeed(release, undefined))
    expect(await removed).toBeNull()
    expect(
      await runtime.runPromise(
        FamilyAdmission.use((service) => service.receipt)
      )
    ).toBeNull()
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await runtime.dispose()
  }
})
it("reacquires a fresh receipt after legacy generation conversion and invalidates it on host close", async () => {
  const f = fixture("new-membership"),
    runtime = f.runtime()
  const receipt = await runtime.runPromise(
    FamilyAdmission.use((service) => service.receipt)
  )
  expect(receipt?.state).toEqual(member)
  expect(receipt?.current()).toBe(true)
  expect(f.writes()).toBe(1)
  await runtime.dispose()
  expect(receipt?.current()).toBe(false)
})
effectIt.effect(
  "expires a receipt at its finite Effect-clock deadline without a new directory lookup",
  () => {
    const f = fixture(versioned(member.membershipId))
    return Effect.gen(function* () {
      const receipt = yield* FamilyAdmission.use((service) => service.receipt)
      expect(receipt?.current()).toBe(true)
      yield* TestClock.adjust("10 seconds")
      expect(receipt?.current()).toBe(false)
    }).pipe(Effect.provide(familyAdmissionApplication(f.host)))
  }
)
