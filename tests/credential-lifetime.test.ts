import { sqliteFailure } from "./sqlite-fault"
import { expect, it } from "@effect/vitest"
import { it as test } from "vitest"
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  ManagedRuntime,
  Redacted,
  Schema,
} from "effect"
import { TestClock } from "effect/testing"
import {
  ModelCredentials,
  OAuthCredential,
  credentialApplication,
  makeModelCredentials,
} from "../src/inference/credentials"
import { SqliteCredentials } from "../src/inference/adapters/credential-sqlite"
import { refreshOAuth } from "../src/inference/adapters/oauth"
import { database } from "./database"

const plain = {
  type: "oauth" as const,
  access: "old-access",
  refresh: "old-refresh",
  expires: 0,
  clientId: "synthetic-client",
}
const next = () =>
  Schema.decodeUnknownSync(OAuthCredential)({
    ...plain,
    access: "new-access",
    refresh: "new-refresh",
    expires: Date.now() + 900_000,
  })
const gate = <T = void>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
const dies = <T, TError>(exit: Exit.Exit<T, TError>, defect: unknown) =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.some(
    (reason) => reason._tag === "Die" && reason.defect === defect
  )
const token = {
  access_token: "new-access",
  refresh_token: "new-refresh",
  expires_in: 3600,
  scope: "chatgpt.tokens.use.direct",
}

it.effect(
  "refresh eligibility and rotated expiry use invocation Clock with the existing buffers",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ledger = new SqliteCredentials(
          database(),
          Redacted.make(JSON.stringify({ ...plain, expires: 400_000 }))
        )
        let calls = 0
        const service = yield* makeModelCredentials(ledger, (current) =>
          refreshOAuth(current, async (_url, options) => {
            calls++
            const form = new URLSearchParams(String(options?.body))
            expect(options?.redirect).toBe("manual")
            expect(form.get("refresh_token")).toBe("old-refresh")
            expect(form.get("resource")).toBe("https://api.openai.com/v1")
            return Response.json(token)
          })
        )
        yield* TestClock.setTime(0)
        yield* service.resolve("openai")
        expect(calls).toBe(0)
        yield* TestClock.setTime(100_000)
        const value = yield* service.resolve("openai")
        expect(value).toMatchObject({ expires: 3_520_000 })
        expect(calls).toBe(1)
      })
    )
)

for (const failed of [false, true])
  test(`explicit shutdown aborts and joins late refresh response cleanup (fails: ${failed})`, async () => {
    const entered = gate(),
      response = gate<Response>(),
      cleaning = gate(),
      close = gate()
    const defect = new Error("refresh response release")
    const db = database(),
      ledger = new SqliteCredentials(db, Redacted.make(JSON.stringify(plain)))
    let signal!: AbortSignal
    const runtime = ManagedRuntime.make(
      credentialApplication(ledger, (current) =>
        refreshOAuth(current, async (_url, options) => {
          signal = options!.signal!
          entered.resolve()
          return response.promise
        })
      )
    )
    const service = runtime.runSync(ModelCredentials)
    const work = runtime.runPromiseExit(service.resolve("openai"))
    await entered.promise
    let closed = false
    const shutdown = runtime.runPromiseExit(service.shutdown()).then((exit) => {
      closed = true
      return exit
    })
    expect(signal.aborted).toBe(true)
    response.resolve(
      new Response(
        new ReadableStream({
          async cancel() {
            cleaning.resolve()
            await close.promise
            if (failed) throw defect
          },
        })
      )
    )
    await cleaning.promise
    expect(closed).toBe(false)
    close.resolve()
    expect(dies(await shutdown, defect)).toBe(failed)
    const result = await work
    expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(
      true
    )
    expect(dies(result, defect)).toBe(failed)
    expect(db.all("SELECT 1 FROM model_credential_refresh")).toHaveLength(1)
    const row = db.all<{ value: string }>(
      "SELECT value FROM model_credentials"
    )[0]!
    expect(JSON.parse(row.value).refresh).toBe("old-refresh")
    expect(
      dies(await Effect.runPromiseExit(runtime.disposeEffect), defect)
    ).toBe(failed)
  })

it.effect(
  "the refresh deadline joins failed native reader cancellation and retains uncertainty",
  () =>
    Effect.gen(function* () {
      const entered = gate(),
        cleaning = gate(),
        close = gate()
      const defect = new Error("refresh deadline release")
      const current = Schema.decodeUnknownSync(OAuthCredential)(plain)
      const body = new ReadableStream<Uint8Array>(
        {
          pull() {
            entered.resolve()
          },
          async cancel() {
            cleaning.resolve()
            await close.promise
            throw defect
          },
        },
        { highWaterMark: 0 }
      )
      const fiber = yield* Effect.forkChild(
        refreshOAuth(current, async () => new Response(body))
      )
      yield* Effect.promise(() => entered.promise)
      try {
        yield* TestClock.adjust("30 seconds")
        yield* Effect.promise(() => cleaning.promise)
        expect(body.locked).toBe(true)
        close.resolve()
        expect(dies(yield* Fiber.await(fiber), defect)).toBe(true)
        expect(body.locked).toBe(false)
      } finally {
        close.resolve()
      }
    })
)

test("a failed intent commit rolls back and dispatches no refresh", async () => {
  const db = database()
  let calls = 0
  db.run(
    "CREATE TRIGGER fail_credential_intent BEFORE INSERT ON model_credential_refresh BEGIN SELECT RAISE(ABORT,'private storage failure'); END"
  )
  const ledger = new SqliteCredentials(db, Redacted.make(JSON.stringify(plain)))
  const runtime = ManagedRuntime.make(
    credentialApplication(ledger, () => {
      calls++
      return Effect.succeed(next())
    })
  )
  const service = runtime.runSync(ModelCredentials)
  try {
    const result = await runtime.runPromise(
      service.resolve("openai").pipe(Effect.result)
    )
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CredentialStorageError" },
    })
    expect(calls).toBe(0)
    expect(db.all("SELECT 1 FROM model_credential_refresh")).toHaveLength(0)
    db.run("DROP TRIGGER fail_credential_intent")
    expect(await runtime.runPromise(service.resolve("openai"))).toBeDefined()
    expect(calls).toBe(1)
  } finally {
    await runtime.runPromise(service.shutdown())
    await runtime.dispose()
  }
})

test("a failed rotation commit preserves the claim and cannot repeat the POST", async () => {
  const db = database()
  let fail = false,
    calls = 0
  const ledger = new SqliteCredentials(
    {
      ...db,
      transaction: (body) =>
        db.transaction(() =>
          body().pipe(
            Effect.flatMap((result) =>
              fail
                ? Effect.fail(sqliteFailure("failed commit"))
                : Effect.succeed(result)
            )
          )
        ),
    },
    Redacted.make(JSON.stringify(plain))
  )
  const runtime = ManagedRuntime.make(
    credentialApplication(ledger, () =>
      Effect.sync(() => {
        calls++
        fail = true
        return next()
      })
    )
  )
  const service = runtime.runSync(ModelCredentials)
  try {
    expect(
      await runtime.runPromise(service.resolve("openai").pipe(Effect.result))
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CredentialStorageError" },
    })
    fail = false
    expect(
      await runtime.runPromise(service.resolve("openai").pipe(Effect.result))
    ).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "CredentialUnavailable",
        message: expect.stringContaining("could not be confirmed"),
      },
    })
    expect(calls).toBe(1)
    expect(db.all("SELECT 1 FROM model_credential_refresh")).toHaveLength(1)
    expect(
      JSON.parse(
        db.all<{ value: string }>("SELECT value FROM model_credentials")[0]!
          .value
      ).refresh
    ).toBe("old-refresh")
  } finally {
    await runtime.runPromise(service.shutdown())
    await runtime.dispose()
  }
})

test("a late rotation cannot overwrite a newer deployment seed", async () => {
  const db = database(),
    entered = gate(),
    release = gate()
  const oldLedger = new SqliteCredentials(
    db,
    Redacted.make(JSON.stringify(plain))
  )
  const first = ManagedRuntime.make(
    credentialApplication(oldLedger, () =>
      Effect.promise(async () => {
        entered.resolve()
        await release.promise
        return next()
      })
    )
  )
  const service = first.runSync(ModelCredentials)
  const old = first.runPromiseExit(service.resolve("openai"))
  await entered.promise
  const newer = {
    ...plain,
    access: "replacement-access",
    refresh: "replacement-refresh",
    expires: Date.now() + 900_000,
  }
  const second = ManagedRuntime.make(
    credentialApplication(
      new SqliteCredentials(db, Redacted.make(JSON.stringify(newer))),
      () => Effect.die("must not refresh")
    )
  )
  try {
    await second.runPromise(
      Effect.flatMap(ModelCredentials, (current) => current.resolve("openai"))
    )
    release.resolve()
    expect(Exit.isFailure(await old)).toBe(true)
    expect(
      JSON.parse(
        db.all<{ value: string }>("SELECT value FROM model_credentials")[0]!
          .value
      )
    ).toEqual(newer)
  } finally {
    release.resolve()
    await first.runPromise(service.shutdown())
    await first.dispose()
    await second.dispose()
  }
})

test("malformed, oversized, scope-invalid and ambiguous refresh responses retain uncertain intents without leaking bodies", async () => {
  for (const response of [
    new Response("private-not-json"),
    new Response("s".repeat(65_537)),
    Response.json({ ...token, scope: "unrelated" }),
    Response.json({ ...token, error: "invalid_grant" }, { status: 400 }),
  ]) {
    const db = database(),
      ledger = new SqliteCredentials(db, Redacted.make(JSON.stringify(plain)))
    const runtime = ManagedRuntime.make(
      credentialApplication(ledger, (current) =>
        refreshOAuth(current, async () => response)
      )
    )
    const service = runtime.runSync(ModelCredentials)
    try {
      const result = await runtime.runPromise(
        service.resolve("openai").pipe(Effect.result)
      )
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "CredentialUnavailable" },
      })
      expect(JSON.stringify(result)).not.toContain("private-not-json")
      expect(db.all("SELECT 1 FROM model_credential_refresh")).toHaveLength(1)
    } finally {
      await runtime.runPromise(service.shutdown())
      await runtime.dispose()
    }
  }
})
