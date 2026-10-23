import { EffectActor } from "@xstate/effect"
import {
  Cause,
  Effect,
  Exit,
  ManagedRuntime,
  Redacted,
  Schema,
  Scheduler,
} from "effect"
import { expect, it, vi } from "vitest"

import { SqliteCredentials } from "../src/inference/adapters/credential-sqlite"
import { credentialHostMachine } from "../src/inference/credential-host.machine"
import {
  advanceCredentialRotation,
  readyRotation,
} from "../src/inference/credential-rotation.machine"
import {
  ModelCredentials,
  OAuthCredential,
  credentialApplication,
  makeModelCredentials,
  CredentialUnavailable,
} from "../src/inference/credentials"
import {
  advanceSignIn,
  type SignInState,
} from "../src/inference/sign-in.machine"
import { orDieAll } from "../src/shared/effect"
import { database } from "./database"

const plain = {
  type: "oauth" as const,
  access: "old-access",
  refresh: "old-refresh",
  expires: Date.now() + 900_000,
  clientId: "client",
  connectionId: "existing-connection",
}
const credential = () => Schema.decodeUnknownSync(OAuthCredential)(plain)
const gate = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
it("converts a legacy uncertain rotation in place without granting a second provider attempt", async () => {
  const db = database(),
    encoded = JSON.stringify(plain)
  db.run(
    "INSERT INTO model_credentials (provider,value,seed,source) VALUES ('openai',?,'','account')",
    encoded
  )
  db.run("INSERT INTO model_credential_refresh (provider) VALUES ('openai')")
  const refresh = vi.fn(() => Effect.succeed(credential()))
  const ledger = new SqliteCredentials(db, Redacted.make(""))
  const runtime = ManagedRuntime.make(credentialApplication(ledger, refresh))
  try {
    const service = runtime.runSync(ModelCredentials)
    await expect(runtime.runPromise(service.resolve("openai"))).rejects.toThrow(
      "could not be confirmed"
    )
    const stored = JSON.parse(
      db.all<{ value: string }>("SELECT value FROM model_credentials")[0]!.value
    )
    expect(stored).toMatchObject({
      ...plain,
      credentialLifecycle: {
        schemaVersion: 1,
        workflowVersion: 1,
        phase: "unconfirmed",
        connectionId: plain.connectionId,
        attemptId: expect.any(String),
      },
    })
    expect(refresh).not.toHaveBeenCalled()
    expect(db.all("SELECT 1 FROM model_credential_refresh")).toHaveLength(1)
    await runtime.runPromise(service.install(credential()))
    expect(db.all("SELECT 1 FROM model_credential_refresh")).toHaveLength(0)
  } finally {
    await runtime.dispose()
  }
})
it("future versions block read and installation without rewriting tokens or metadata", async () => {
  const db = database()
  const saved = JSON.stringify({
    ...plain,
    credentialLifecycle: {
      ...readyRotation(plain.connectionId),
      workflowVersion: 2,
    },
  })
  db.run(
    "INSERT INTO model_credentials (provider,value,seed,source) VALUES ('openai',?,'','account')",
    saved
  )
  const ledger = new SqliteCredentials(db, Redacted.make(""))
  const runtime = ManagedRuntime.make(
    credentialApplication(ledger, () => Effect.die("Unexpected provider"))
  )
  try {
    const service = runtime.runSync(ModelCredentials)
    await expect(runtime.runPromise(service.resolve("openai"))).rejects.toThrow(
      "newer credential lifecycle"
    )
    await expect(
      runtime.runPromise(service.install(credential()))
    ).rejects.toThrow("newer credential lifecycle")
    expect(
      db.all<{ value: string }>("SELECT value FROM model_credentials")[0]!.value
    ).toBe(saved)
  } finally {
    await runtime.dispose()
  }
})
it("a corrupted known projection is fatal and never reconstructed as a fresh grant", async () => {
  const db = database(),
    ledger = new SqliteCredentials(db, Redacted.make(""))
  Effect.runSync(ledger.install("openai", credential()))
  db.run("INSERT INTO model_credential_refresh (provider) VALUES ('openai')")
  const exit = await Effect.runPromiseExit(ledger.read("openai"))
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(JSON.stringify(exit)).not.toContain(plain.refresh)
  expect(db.all("SELECT 1 FROM model_credential_refresh")).toHaveLength(1)
})
it("rotation events require the exact attempt and connection; uncertainty cannot rearm itself", () => {
  const ready = readyRotation("connection"),
    event = {
      type: "CLAIM" as const,
      connectionId: "connection",
      attemptId: "attempt",
    }
  const rotating = advanceCredentialRotation(ready, event)
  for (const stale of [
    { ...event, type: "COMPLETE" as const, attemptId: "older" },
    { ...event, type: "COMPLETE" as const, connectionId: "older" },
  ])
    expect(advanceCredentialRotation(rotating, stale)).toEqual(rotating)
  const uncertain = advanceCredentialRotation(rotating, {
    ...event,
    type: "UNCERTAIN",
  })
  expect(advanceCredentialRotation(uncertain, event)).toEqual(uncertain)
  expect(
    advanceCredentialRotation(rotating, { ...event, type: "COMPLETE" })
  ).toEqual(ready)
  expect(() =>
    advanceCredentialRotation(ready, { ...event, attemptId: 42 } as never)
  ).toThrow()
})
it("sign-in claim and completion retain the original principal and reject malformed events", () => {
  const state: SignInState = {
    schemaVersion: 1,
    workflowVersion: 1,
    id: "sign-in",
    owner: "owner",
    membershipId: "membership",
    expiresAt: 100,
    phase: "waiting",
  }
  const event = {
    type: "CLAIM" as const,
    id: state.id,
    owner: state.owner,
    membershipId: state.membershipId,
    now: 1,
  }
  expect(advanceSignIn(state, { ...event, now: 100 })).toEqual(state)
  expect(advanceSignIn(state, { ...event, membershipId: "old" })).toEqual(state)
  const pending = advanceSignIn(state, event)
  expect(
    advanceSignIn(pending, { ...event, type: "CONNECTED", id: "old" })
  ).toEqual(pending)
  expect(() =>
    advanceSignIn(state, { ...event, now: "never" } as never)
  ).toThrow()
})
it("factory interruption joins the actor acquired before its cleanup was installed", async () => {
  const controller = new AbortController(),
    original = credentialHostMachine.initialTransition.bind(
      credentialHostMachine
    )
  const initial = vi
    .spyOn(credentialHostMachine, "initialTransition")
    .mockImplementation((...args) => {
      const snapshot = original(...args)
      queueMicrotask(() => controller.abort())
      return snapshot
    })
  const stopped = vi.spyOn(EffectActor.prototype, "stop")
  try {
    const exit = await Effect.runPromiseExit(
      makeModelCredentials(
        new SqliteCredentials(database(), Redacted.make("")),
        () => Effect.never
      ).pipe(
        Effect.scoped,
        Effect.provideService(Scheduler.MaxOpsBeforeYield, 32)
      ),
      { signal: controller.signal }
    )
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(stopped).toHaveBeenCalledOnce()
  } finally {
    initial.mockRestore()
    stopped.mockRestore()
  }
})
it("account shutdown joins connect cleanup and retains every late compound cause reason", async () => {
  const entered = gate(),
    cleaning = gate(),
    release = gate()
  const defect = new Error("late connect cleanup"),
    checked = new CredentialUnavailable({ message: "late checked cleanup" })
  const runtime = ManagedRuntime.make(
    credentialApplication(
      new SqliteCredentials(database(), Redacted.make(JSON.stringify(plain))),
      () => Effect.never
    )
  )
  const service = runtime.runSync(ModelCredentials)
  const exchange = Effect.scoped(
    Effect.acquireRelease(Effect.sync(entered.resolve), () =>
      Effect.promise(async () => {
        cleaning.resolve()
        await release.promise
      }).pipe(
        Effect.andThen(
          Effect.failCause(
            Cause.fromReasons([
              Cause.makeFailReason(checked),
              Cause.makeDieReason(defect),
            ])
          ).pipe(orDieAll)
        )
      )
    ).pipe(Effect.andThen(Effect.never))
  )
  const work = runtime.runPromiseExit(
    service.connect(exchange, Effect.void, plain.connectionId)
  )
  await entered.promise
  let closed = false
  const closing = runtime.runPromiseExit(service.shutdown()).then((exit) => {
    closed = true
    return exit
  })
  await cleaning.promise
  expect(closed).toBe(false)
  release.resolve()
  const result = await work,
    shutdown = await closing
  for (const exit of [result, shutdown] as Array<Exit.Exit<unknown, unknown>>) {
    expect(
      Exit.isFailure(exit) &&
        exit.cause.reasons.some(
          (reason) => reason._tag === "Die" && reason.defect === defect
        )
    ).toBe(true)
    expect(
      Exit.isFailure(exit) &&
        exit.cause.reasons.some(
          (reason) =>
            reason._tag === "Die" &&
            typeof reason.defect === "object" &&
            reason.defect !== null &&
            "error" in reason.defect &&
            reason.defect.error === checked
        )
    ).toBe(true)
  }
  await Effect.runPromiseExit(runtime.disposeEffect)
})
