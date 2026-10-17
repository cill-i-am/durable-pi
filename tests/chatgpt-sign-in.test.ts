import { createHash } from "node:crypto"

import { Effect, Logger, ManagedRuntime, Redacted } from "effect"
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose"
import { afterEach, beforeAll, expect, it, vi } from "vitest"

import {
  ChatGPTSignIn,
  chatGPTSignInRequest,
  type ChatGPTSignInPending,
} from "../src/inference/adapters/chatgpt-sign-in"
import { SqliteCredentials } from "../src/inference/adapters/credential-sqlite"
import {
  ModelCredentials,
  CredentialUnavailable,
  credentialApplication,
} from "../src/inference/credentials"
import { database } from "./database"

let pair: Awaited<ReturnType<typeof generateKeyPair>>
let keys: ReturnType<typeof createLocalJWKSet>
beforeAll(async () => {
  pair = await generateKeyPair("RS256")
  keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "synthetic" }],
  })
})
const disposals: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose()
})
const pendingKey = "chatgpt-pending-sign-in-v1"
function fixture() {
  const saved = new Map<string, unknown>()
  let tail = Promise.resolve()
  const storage: Pick<DurableObjectStorage, "transaction"> = {
    transaction: (body) => {
      const run = tail.then(async () => {
        const next = new Map(saved)
        const transaction = {
          get: async (key: string) => next.get(key),
          put: async (key: string, value: unknown) => {
            next.set(key, structuredClone(value))
          },
          delete: async (key: string) => next.delete(key),
        } as DurableObjectTransaction
        const result = await body(transaction)
        saved.clear()
        for (const [key, value] of next) saved.set(key, value)
        return result
      })
      tail = run.then(
        () => {},
        () => {}
      )
      return run
    },
  }
  const db = database()
  const ledger = new SqliteCredentials(
    db,
    Redacted.make(
      JSON.stringify({
        type: "oauth",
        access: "old-access",
        refresh: "old-refresh",
        clientId: "oaiapp_synthetic",
        expires: Date.now() + 3_600_000,
      })
    )
  )
  const runtime = ManagedRuntime.make(
    credentialApplication(ledger, () => Effect.die("Unexpected refresh"))
  )
  disposals.push(() => runtime.dispose())
  const service = runtime.runSync(ModelCredentials)
  let membership = "admin-membership",
    permitted = true
  let started: ChatGPTSignInPending
  let overrides: Record<string, unknown> = {}
  let beforeExchange = async () => {}
  const warnings: unknown[] = []
  const transport = vi.fn(
    async (_url: string | URL | Request, init?: RequestInit) => {
      expect(saved.has(pendingKey)).toBe(false)
      expect(init?.redirect).toBe("manual")
      const params = new URLSearchParams(init?.body as string)
      const url = new URL(started.authorizationUrl)
      expect(params.get("client_id")).toBe("oaiapp_synthetic")
      expect(params.get("redirect_uri")).toBe(
        url.searchParams.get("redirect_uri")
      )
      expect(
        createHash("sha256")
          .update(params.get("code_verifier")!)
          .digest("base64url")
      ).toBe(url.searchParams.get("code_challenge"))
      await beforeExchange()
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        scope:
          "openid offline_access resource.invoke chatgpt.tokens.use.direct",
        id_token: await new SignJWT({
          nonce: url.searchParams.get("nonce"),
          email: "owner@example.invalid",
          email_verified: true,
          ...overrides,
        })
          .setProtectedHeader({ alg: "RS256", kid: "synthetic" })
          .setIssuer("https://auth.openai.com")
          .setAudience("oaiapp_synthetic")
          .setSubject("synthetic-owner")
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(pair.privateKey),
        ...(overrides.scope !== undefined ? { scope: overrides.scope } : {}),
      })
    }
  )
  const admit = () =>
    permitted
      ? Effect.succeed({ owner: "owner", membershipId: membership })
      : Effect.fail(
          new CredentialUnavailable({ message: "Admin access ended" })
        )
  const controller = () =>
    new ChatGPTSignIn(storage, ledger, service, admit, transport, keys)
  let host = controller()
  async function start() {
    started = await Effect.runPromise(host.start("owner@example.invalid"))
    return started
  }
  const address = () => {
    const url = new URL(started.authorizationUrl)
    const result = new URL(url.searchParams.get("redirect_uri")!)
    result.search = new URLSearchParams({
      state: url.searchParams.get("state")!,
      code: "synthetic-code",
    }).toString()
    return result.href
  }
  return {
    saved,
    db,
    ledger,
    service,
    runtime,
    transport,
    start,
    address,
    current: () => Effect.runSync(ledger.read("openai")),
    restart: () => {
      host = controller()
    },
    status: () => Effect.runPromise(host.status()),
    warnings,
    finish: () =>
      Effect.runPromise(
        host.finish(started.id, address()).pipe(
          Effect.provide(
            Logger.layer([
              Logger.make((entry) => {
                warnings.push(Logger.formatStructured.log(entry))
              }),
            ])
          )
        )
      ),
    submit: (value: string) =>
      Effect.runPromise(host.finish(started.id, value)),
    request: (request: Request) =>
      Effect.runPromise(chatGPTSignInRequest(host, request)),
    deny: () => {
      permitted = false
    },
    rejoin: () => {
      membership = "new-membership"
    },
    claims: (value: Record<string, unknown>) => {
      overrides = value
    },
    exchange: (work: () => Promise<void>) => {
      beforeExchange = work
    },
  }
}
it("finishes an admin sign-in after actor restart, keeping tokens server-side and preserving this runtime host ID", async () => {
  const f = fixture()
  const first = await f.start()
  expect(JSON.stringify(first)).not.toContain("verifier")
  f.restart()
  expect((await f.status()).pending).toEqual(first)
  expect(await f.finish()).toEqual({
    status: "connected",
    email: "owner@example.invalid",
  })
  expect(JSON.stringify(await f.status())).not.toContain("new-refresh")
  expect(f.current()).toMatchObject({
    seedCurrent: true,
    value: {
      access: Redacted.make("new-access"),
      identity: { subject: "synthetic-owner" },
    },
  })
  const second = await f.start()
  expect(
    new URL(second.authorizationUrl).searchParams.get("ext_agent_host_id")
  ).toBe(new URL(first.authorizationUrl).searchParams.get("ext_agent_host_id"))
  expect(second.id).not.toBe(first.id)
})
it("exchanges the code without binding native fetch to the sign-in service", async () => {
  const f = fixture()
  await f.start()
  await f.finish()
  expect(f.transport.mock.contexts[0]).toBeUndefined()
})
it("rejects changed callback state, origin, path, duplicate codes and fragments before dispatch", async () => {
  const f = fixture()
  await f.start()
  for (const change of [
    (url: URL) => url.searchParams.set("state", "wrong"),
    (url: URL) => {
      url.hostname = "localhost"
    },
    (url: URL) => {
      url.pathname = "/another-callback"
    },
    (url: URL) => url.searchParams.append("code", "duplicate"),
    (url: URL) => {
      url.hash = "unexpected"
    },
  ]) {
    const url = new URL(f.address())
    change(url)
    await expect(f.submit(url.href)).rejects.toThrow("full return address")
  }
  expect(f.transport).not.toHaveBeenCalled()
  expect((await f.status()).pending).not.toBeNull()
})
it("consumes an accepted code exactly once across concurrent completion and restart", async () => {
  const f = fixture()
  await f.start()
  const results = await Promise.allSettled([f.finish(), f.finish()])
  expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(
    1
  )
  expect(f.transport).toHaveBeenCalledTimes(1)
  f.restart()
  await expect(f.finish()).rejects.toThrow("already used")
  expect(f.transport).toHaveBeenCalledTimes(1)
})
it("does not replace the existing grant after an uncertain exchange or repeat its code", async () => {
  const f = fixture()
  await f.start()
  await f.runtime.runPromise(f.service.resolve("openai"))
  f.exchange(async () => {
    throw new TypeError("synthetic private diagnostic")
  })
  await expect(f.finish()).rejects.toThrow("existing connection has been kept")
  f.restart()
  await expect(f.finish()).rejects.toThrow("already used")
  expect(f.transport).toHaveBeenCalledTimes(1)
  expect(f.current()).toMatchObject({
    value: { access: Redacted.make("old-access") },
  })
})
it("rejects a token endpoint redirect without installing credentials or replaying the code", async () => {
  const f = fixture()
  await f.start()
  f.transport.mockResolvedValueOnce(
    new Response(null, {
      status: 302,
      headers: { location: "https://unexpected.invalid/token" },
    })
  )
  await expect(f.finish()).rejects.toThrow("existing connection has been kept")
  await expect(f.finish()).rejects.toThrow("already used")
  expect(f.transport).toHaveBeenCalledTimes(1)
  expect(f.current()).toBeUndefined()
  expect(JSON.stringify(f.warnings)).toContain("token_exchange")
  expect(JSON.stringify(f.warnings)).toContain("302")
  expect(JSON.stringify(f.warnings)).not.toContain("unexpected.invalid")
})
it("logs only a fixed credential rejection reason, never the token or returned identity", async () => {
  const f = fixture()
  await f.start()
  f.claims({ email: "private-returned-identity@example.invalid" })
  await expect(f.finish()).rejects.toThrow("existing connection has been kept")
  const warnings = JSON.stringify(f.warnings)
  expect(warnings).toContain("credential_validation")
  expect(warnings).toContain("email_mismatch")
  for (const secret of [
    "private-returned-identity",
    "new-access",
    "new-refresh",
    "synthetic-code",
    "eyJ",
  ])
    expect(warnings).not.toContain(secret)
})
it.each([
  { nonce: "other" },
  { email: "another@example.invalid" },
  { email_verified: false },
  { scope: "openid" },
])(
  "rejects unverified identity or missing model permission: %j",
  async (claims) => {
    const f = fixture()
    await f.start()
    await f.runtime.runPromise(f.service.resolve("openai"))
    f.claims(claims)
    await expect(f.finish()).rejects.toThrow(
      "existing connection has been kept"
    )
    expect(f.current()).toMatchObject({
      value: { access: Redacted.make("old-access") },
    })
  }
)
it("rejects an expired attempt or a different membership generation", async () => {
  const f = fixture()
  await f.start()
  const pending = f.saved.get(pendingKey) as Record<string, unknown>
  f.saved.set(pendingKey, { ...pending, expiresAt: 1 })
  await expect(f.finish()).rejects.toThrow("expired")
  expect((await f.status()).pending).toBeNull()
  await f.start()
  f.rejoin()
  await expect(f.finish()).rejects.toThrow("expired")
  expect(f.transport).not.toHaveBeenCalled()
})
it("revalidates admin admission after code exchange before committing the new grant", async () => {
  const f = fixture()
  await f.start()
  await f.runtime.runPromise(f.service.resolve("openai"))
  f.exchange(async () => {
    f.deny()
  })
  await expect(f.finish()).rejects.toThrow("Admin access ended")
  expect(f.current()).toMatchObject({
    value: { access: Redacted.make("old-access") },
  })
})
it("bounds and validates HTTP input, and exposes no sign-in state to an unauthorized principal", async () => {
  const f = fixture()
  const invalid = await f.request(
    new Request("https://pi.example/api/agent/model-account", {
      method: "POST",
      body: JSON.stringify({ action: "start", email: "invalid" }),
    })
  )
  expect(invalid.status).toBe(400)
  f.deny()
  const denied = await f.request(
    new Request("https://pi.example/api/agent/model-account")
  )
  expect(denied.status).toBe(403)
  expect(await denied.text()).not.toContain("authorizationUrl")
})
