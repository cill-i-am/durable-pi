import { Cause, Effect, Exit, ManagedRuntime, Redacted, Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { SqliteCredentials } from "../src/inference/adapters/credential-sqlite"
import {
  accountCredentials,
  toNativeCredential,
} from "../src/inference/adapters/credentials-pi"
import { refreshOAuth } from "../src/inference/adapters/oauth"
import {
  ModelCredentials,
  ModelCredential,
  credentialApplication,
  CredentialRefreshError,
  type CredentialRefresh,
} from "../src/inference/credentials"
import { database } from "./database"

const seedValue = {
  type: "oauth" as const,
  access: "test-access",
  refresh: "test-refresh",
  expires: 0,
  clientId: "test-client",
}
const seed = JSON.stringify(seedValue)
const rotated = () =>
  Schema.decodeUnknownSync(ModelCredential.members[0])({
    ...seedValue,
    access: "rotated-access",
    refresh: "rotated-refresh",
    expires: Date.now() + 600_000,
  })
const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
})
const fixture = (
  db = database(),
  encodedSeed = seed,
  refresh: CredentialRefresh = () => Effect.succeed(rotated())
) => {
  const ledger = new SqliteCredentials(db, Redacted.make(encodedSeed))
  const runtime = ManagedRuntime.make(credentialApplication(ledger, refresh))
  const service = runtime.runSync(ModelCredentials)
  disposals.push(async () => {
    await runtime.runPromise(service.shutdown())
    await runtime.dispose()
  })
  return {
    db,
    ledger,
    service,
    runtime,
    resolve: () => runtime.runPromise(service.resolve("openai")),
    pending: () => db.all("SELECT 1 FROM model_credential_refresh").length,
  }
}
const gate = <T = void>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

describe("private model credentials", () => {
  it("keeps an in-product connection across restart and later deployment seed changes", async () => {
    const f = fixture()
    const next = rotated()
    await f.runtime.runPromise(f.service.install(next))
    expect(f.db.all("SELECT source FROM model_credentials")).toEqual([
      { source: "account" },
    ])
    const replacementSeed = JSON.stringify({
      ...seedValue,
      access: "stale-deploy-token",
      expires: Date.now() + 900_000,
    })
    const restored = fixture(f.db, replacementSeed)
    expect(toNativeCredential((await restored.resolve())!)).toMatchObject({
      access: "rotated-access",
      refresh: "rotated-refresh",
    })
    expect(f.pending()).toBe(0)
  })
  it("settles an old rotation before installing the new grant and never writes it over the replacement", async () => {
    const entered = gate(),
      finish = gate()
    const f = fixture(undefined, seed, () =>
      Effect.promise(async () => {
        entered.resolve()
        await finish.promise
        return rotated()
      })
    )
    const refresh = f.resolve()
    await entered.promise
    const next = Schema.decodeUnknownSync(ModelCredential.members[0])({
      ...seedValue,
      access: "new-grant-access",
      refresh: "new-grant-refresh",
      expires: Date.now() + 900_000,
    })
    const install = f.runtime.runPromise(f.service.install(next))
    finish.resolve()
    await Promise.all([refresh, install])
    expect(toNativeCredential((await f.resolve())!)).toMatchObject({
      access: "new-grant-access",
      refresh: "new-grant-refresh",
    })
    expect(f.pending()).toBe(0)
  })
  it("keeps the account connection authoritative after its tokens rotate", async () => {
    const f = fixture()
    await f.runtime.runPromise(
      f.service.install(
        Schema.decodeUnknownSync(ModelCredential.members[0])(seedValue)
      )
    )
    await f.resolve()
    expect(f.db.all("SELECT source FROM model_credentials")).toEqual([
      { source: "account" },
    ])
    const restored = fixture(
      f.db,
      JSON.stringify({ ...seedValue, access: "old-deployment" })
    )
    expect(toNativeCredential((await restored.resolve())!)).toMatchObject({
      access: "rotated-access",
      refresh: "rotated-refresh",
    })
  })
  it("does not replace an invalid account connection with a deployment seed", async () => {
    const f = fixture()
    await f.runtime.runPromise(f.service.install(rotated()))
    f.db.run("UPDATE model_credentials SET value='{}'")
    const restored = fixture(
      f.db,
      JSON.stringify({ ...seedValue, access: "old-deployment" })
    )
    await expect(restored.resolve()).rejects.toThrow(
      "The stored model credential is invalid"
    )
    expect(f.db.all("SELECT value,source FROM model_credentials")).toEqual([
      { value: "{}", source: "account" },
    ])
  })
  it("recovers an uncertain rotation only by installing a newly authorized grant", async () => {
    const f = fixture(undefined, seed, () =>
      Effect.fail(
        new CredentialRefreshError({
          reason: "unavailable",
          message: "Unconfirmed",
        })
      )
    )
    await expect(f.resolve()).rejects.toThrow("Unconfirmed")
    expect(f.pending()).toBe(1)
    await f.runtime.runPromise(f.service.install(rotated()))
    expect(f.pending()).toBe(0)
    expect(toNativeCredential((await f.resolve())!)).toMatchObject({
      access: "rotated-access",
    })
  })
  it("coalesces account refresh, commits the intent before dispatch and persists rotated tokens across restart", async () => {
    const entered = gate(),
      finish = gate()
    let calls = 0
    const f = fixture(undefined, seed, () =>
      Effect.promise(async () => {
        calls++
        expect(f.pending()).toBe(1)
        entered.resolve()
        await finish.promise
        return rotated()
      })
    )
    const first = f.resolve(),
      second = f.resolve()
    await entered.promise
    finish.resolve()
    const values = await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(values.map((value) => value && toNativeCredential(value))).toEqual([
      expect.objectContaining({ access: "rotated-access" }),
      expect.objectContaining({ access: "rotated-access" }),
    ])
    expect(f.pending()).toBe(0)
    const restored = fixture(f.db)
    expect(toNativeCredential((await restored.resolve())!)).toMatchObject({
      refresh: "rotated-refresh",
    })
  })
  it("adopts a changed deployment seed, repairs old corrupt data and clears uncertain rotation state", async () => {
    const f = fixture()
    await f.resolve()
    f.db.run("UPDATE model_credentials SET value='{}'")
    Effect.runSync(f.ledger.claim("openai", true))
    const next = JSON.stringify({
      ...seedValue,
      access: "replacement",
      expires: Date.now() + 900_000,
    })
    const restored = fixture(f.db, next)
    expect(toNativeCredential((await restored.resolve())!)).toMatchObject({
      access: "replacement",
    })
    expect(restored.pending()).toBe(0)
  })
  it("keeps secret values redacted internally and preserves the existing encoded table format", async () => {
    const f = fixture()
    const value = await f.resolve()
    expect(JSON.stringify(value)).not.toContain("rotated-access")
    expect(
      String(value && value.type === "oauth" && value.access)
    ).not.toContain("rotated-access")
    const row = f.db.all<{ value: string }>(
      "SELECT value FROM model_credentials"
    )[0]!
    expect(JSON.parse(row.value)).toEqual({
      ...seedValue,
      access: "rotated-access",
      refresh: "rotated-refresh",
      expires: expect.any(Number),
    })
  })
  it("never repeats an unconfirmed refresh after failure or a cold application restart", async () => {
    let calls = 0
    const f = fixture(undefined, seed, () => {
      calls++
      return Effect.fail(
        new CredentialRefreshError({
          reason: "unavailable",
          message: "Unconfirmed",
        })
      )
    })
    await expect(f.resolve()).rejects.toThrow("Unconfirmed")
    await expect(f.resolve()).rejects.toThrow("could not be confirmed")
    const restored = fixture(f.db, seed, () => {
      calls++
      return Effect.succeed(rotated())
    })
    await expect(restored.resolve()).rejects.toThrow("could not be confirmed")
    expect(calls).toBe(1)
    expect(f.pending()).toBe(1)
  })
  it("clears a confirmed OAuth denial without automatically retrying it", async () => {
    let calls = 0
    const f = fixture(undefined, seed, () => {
      calls++
      return Effect.fail(
        new CredentialRefreshError({ reason: "rejected", message: "Denied" })
      )
    })
    await expect(f.resolve()).rejects.toThrow("Denied")
    expect(calls).toBe(1)
    expect(f.pending()).toBe(0)
  })
  it("a cancelled waiter joins the accepted rotation without aborting it or losing its tokens", async () => {
    const entered = gate(),
      finish = gate()
    const f = fixture(undefined, seed, () =>
      Effect.promise(async () => {
        entered.resolve()
        await finish.promise
        return rotated()
      })
    )
    const controller = new AbortController()
    let settled = false
    const first = f.runtime
      .runPromiseExit(f.service.resolve("openai"), {
        signal: controller.signal,
      })
      .then((exit) => {
        settled = true
        return exit
      })
    await entered.promise
    const second = f.resolve()
    controller.abort()
    expect(settled).toBe(false)
    finish.resolve()
    const exit = await first
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(toNativeCredential((await second)!)).toMatchObject({
      refresh: "rotated-refresh",
    })
    expect(f.pending()).toBe(0)
  })
  it("does not refresh an already-stopped call or seed other providers", async () => {
    let calls = 0
    const f = fixture(undefined, seed, () => {
      calls++
      return Effect.succeed(rotated())
    })
    const exit = await f.runtime.runPromiseExit(f.service.resolve("openai"), {
      signal: AbortSignal.abort(),
    })
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(
      await f.runtime.runPromise(f.service.resolve("other"))
    ).toBeUndefined()
    expect(f.db.all("SELECT 1 FROM model_credentials")).toEqual([])
    expect(calls).toBe(0)
  })
  it("keeps child credentials read-only and leaves refresh/persistence with the owner", async () => {
    const f = fixture()
    const owner = async () => {
      const value = await f.resolve()
      return value ? toNativeCredential(value) : undefined
    }
    const bots = [accountCredentials(owner), accountCredentials(owner)]
    expect(await Promise.all(bots.map((bot) => bot.read("openai")))).toEqual([
      expect.objectContaining({ refresh: "rotated-refresh" }),
      expect.objectContaining({ refresh: "rotated-refresh" }),
    ])
    await bots[0]!.modify("openai", async () => {
      throw new Error("Child must not refresh")
    })
    await expect(bots[0]!.delete("openai")).rejects.toThrow("owner account")
  })
  it("sanitizes corrupt durable credentials without echoing their raw secret in defects", async () => {
    const f = fixture(undefined, "")
    f.db.run(
      "INSERT INTO model_credentials(provider,value,seed) VALUES (?,?,?)",
      "openai",
      '{"access":"private-secret"}',
      ""
    )
    const exit = await f.runtime.runPromiseExit(f.service.resolve("openai"))
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    expect(JSON.stringify(exit)).not.toContain("private-secret")
  })
  it("only treats a decoded OAuth error response as a definitive denial", async () => {
    for (const [response, confirmed] of [
      [Response.json({ error: "invalid_grant" }, { status: 400 }), true],
      [new Response("private diagnostic", { status: 500 }), false],
    ] as const) {
      const f = fixture(undefined, seed, (current) =>
        refreshOAuth(current, async () => response)
      )
      await expect(f.resolve()).rejects.toThrow("ChatGPT authorization expired")
      expect(f.pending()).toBe(confirmed ? 0 : 1)
    }
  })
})
