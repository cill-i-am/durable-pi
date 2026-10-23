import { Clock, Effect, ManagedRuntime, Redacted } from "effect"
import { expect, it } from "vitest"

import { ChatGPTSignIn } from "../src/inference/adapters/chatgpt-sign-in"
import { SqliteCredentials } from "../src/inference/adapters/credential-sqlite"
import {
  ModelCredentials,
  credentialApplication,
} from "../src/inference/credentials"
import { database } from "./database"

it("sign-in admission rechecks expiry after acquiring the KV transaction", async () => {
  let now = 1000000
  const baseClock = Effect.runSync(Clock.Clock)
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => baseClock.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: baseClock.monotonicTimeNanos,
    sleep: (duration) => baseClock.sleep(duration),
  }
  const saved = new Map<string, unknown>()
  let calls = 0,
    transactions = 0
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const storage = {
    transaction: async (
      body: (tx: DurableObjectTransaction) => Promise<unknown>
    ) => {
      transactions++
      if (transactions === 3) {
        enter()
        await held
      }
      return body({
        get: async (key: string) => saved.get(key),
        put: async (key: string, value: unknown) => {
          saved.set(key, structuredClone(value))
        },
      } as DurableObjectTransaction)
    },
  } as Pick<DurableObjectStorage, "transaction">
  const ledger = new SqliteCredentials(
    database(),
    Redacted.make(
      JSON.stringify({
        type: "oauth",
        access: "synthetic-access",
        refresh: "synthetic-refresh",
        clientId: "synthetic-client",
        expires: now + 3600000,
      })
    )
  )
  const runtime = ManagedRuntime.make(
    credentialApplication(ledger, () => Effect.die("no refresh"))
  )
  const credentials = runtime.runSync(ModelCredentials)
  const host = new ChatGPTSignIn(
    storage,
    ledger,
    credentials,
    () => Effect.succeed({ owner: "owner", membershipId: "membership" }),
    async () => {
      calls++
      return new Response("synthetic rejection", { status: 400 })
    }
  )
  try {
    const pending = await Effect.runPromise(
      host
        .start("owner@example.invalid")
        .pipe(Effect.provideService(Clock.Clock, clock))
    )
    const url = new URL(pending.authorizationUrl)
    const address = new URL(url.searchParams.get("redirect_uri")!)
    address.search = new URLSearchParams({
      state: url.searchParams.get("state")!,
      code: "synthetic-code",
    }).toString()
    const finishing = Effect.runPromiseExit(
      host
        .finish(pending.id, address.href)
        .pipe(Effect.provideService(Clock.Clock, clock))
    )
    await entered
    now = pending.expiresAt + 1
    release()
    await finishing
    expect(calls).toBe(0)
    expect(saved.get("chatgpt-pending-sign-in-v1")).toMatchObject({
      phase: "waiting",
    })
  } finally {
    release()
    await runtime.dispose()
  }
})
