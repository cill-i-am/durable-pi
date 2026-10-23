import { createHash } from "node:crypto"

import { Effect, Logger, ManagedRuntime, Redacted, Schema } from "effect"
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
  OAuthCredential,
  CredentialUnavailable,
  credentialApplication,
  type CredentialRefresh,
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
function fixture(
  refresh: CredentialRefresh = () => Effect.die("Unexpected refresh")
) {
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
  const runtime = ManagedRuntime.make(credentialApplication(ledger, refresh))
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
      expect(saved.get(pendingKey)).toMatchObject({
        phase: "exchanging",
        schemaVersion: 1,
        workflowVersion: 1,
      })
      expect(saved.get(pendingKey)).not.toHaveProperty("pending")
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
    finishWithSignal: (signal: AbortSignal) =>
      Effect.runPromise(host.finish(started.id, address()), { signal }),
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
  expect(f.current()).toMatchObject({
    value: {
      access: Redacted.make("old-access"),
      refresh: Redacted.make("old-refresh"),
    },
  })
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
  f.saved.set(pendingKey, {
    ...pending,
    expiresAt: 1,
    pending: { ...(pending.pending as Record<string, unknown>), expiresAt: 1 },
  })
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

it("an accepted sign-in exchange belongs to the account after its browser leaves", async () => {
  const f = fixture()
  await f.start()
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const finish = new Promise<void>((resolve) => {
    release = resolve
  })
  f.exchange(async () => {
    entered()
    await finish
  })
  const browser = new AbortController()
  const result = f.finishWithSignal(browser.signal).then(
    () => "connected",
    () => "interrupted"
  )
  await started
  try {
    browser.abort()
    expect(f.transport.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
    release()
    await result
    expect(f.current()).toMatchObject({
      value: { refresh: Redacted.make("new-refresh") },
    })
    expect(f.transport).toHaveBeenCalledTimes(1)
    expect(f.saved.get(pendingKey)).toMatchObject({ phase: "connected" })
  } finally {
    release()
    await result
  }
})

it("restores legacy waiting sign-in without changing its PKCE challenge or attempt identity", async () => {
  const f = fixture(),
    started = await f.start()
  const saved = f.saved.get(pendingKey) as { pending: unknown }
  f.saved.set(pendingKey, saved.pending)
  f.restart()
  expect(await f.status()).toEqual({ pending: started })
  expect(f.saved.get(pendingKey)).toMatchObject({
    schemaVersion: 1,
    workflowVersion: 1,
    id: started.id,
    phase: "waiting",
  })
  await f.finish()
  expect(f.saved.get(pendingKey)).toMatchObject({
    id: started.id,
    phase: "connected",
  })
  expect(f.saved.get(pendingKey)).not.toHaveProperty("pending")
})
it("future sign-in data is retained and blocks start instead of resetting the attempt", async () => {
  const f = fixture()
  await f.start()
  const saved = { ...(f.saved.get(pendingKey) as object), workflowVersion: 2 }
  f.saved.set(pendingKey, saved)
  await expect(f.status()).rejects.toThrow("newer lifecycle")
  await expect(f.start()).rejects.toThrow("newer lifecycle")
  expect(f.saved.get(pendingKey)).toEqual(saved)
  expect(f.transport).not.toHaveBeenCalled()
})
it("known corrupted sign-in data is a sanitized defect", async () => {
  const f = fixture()
  await f.start()
  const saved = f.saved.get(pendingKey) as { pending: object }
  f.saved.set(pendingKey, {
    ...saved,
    pending: { ...saved.pending, verifier: { secret: "private-verifier" } },
  })
  const result = await f.status().then(
    () => undefined,
    (error: unknown) => error
  )
  expect(String(result)).toContain("stored sign-in lifecycle is invalid")
  expect(String(result)).not.toContain("private-verifier")
  expect(f.transport).not.toHaveBeenCalled()
})
it("a late sign-in cannot replace a newer connection installed by another account host", async () => {
  const f = fixture()
  await f.start()
  f.exchange(async () => {
    await Effect.runPromise(
      f.ledger.install(
        "openai",
        Schema.decodeUnknownSync(OAuthCredential)({
          type: "oauth",
          access: "newer-access",
          refresh: "newer-refresh",
          expires: Date.now() + 900_000,
          clientId: "oaiapp_synthetic",
          connectionId: "newer-connection",
        })
      )
    )
  })
  await expect(f.finish()).rejects.toThrow("model connection changed")
  expect(f.current()).toMatchObject({
    value: {
      access: Redacted.make("newer-access"),
      connectionId: "newer-connection",
    },
  })
  expect(f.saved.get(pendingKey)).toMatchObject({ phase: "unconfirmed" })
})

it("browser departure before account admission leaves the authorization code unconsumed", async () => {
  let entered!: () => void, release!: () => void, queued!: () => void
  const rotating = new Promise<void>((resolve) => {
    entered = resolve
  })
  const complete = new Promise<void>((resolve) => {
    release = resolve
  })
  const admitted = new Promise<void>((resolve) => {
    queued = resolve
  })
  const f = fixture((current) =>
    Effect.promise(async () => {
      entered()
      await complete
      return { ...current, expires: Date.now() + 900_000 }
    })
  )
  await f.start()
  const current = f.current()!
  if (!current.seedCurrent || current.value.type !== "oauth")
    throw new Error("missing fixture grant")
  await Effect.runPromise(
    f.ledger.put("openai", { ...current.value, expires: 0 })
  )
  const rotation = f.runtime.runPromise(f.service.resolve("openai", true))
  await rotating
  const original = f.service.connect
  const observe = vi
    .spyOn(f.service, "connect")
    .mockImplementation((...args) =>
      Effect.sync(queued).pipe(Effect.andThen(original(...args)))
    )
  const browser = new AbortController()
  const finish = f.finishWithSignal(browser.signal).catch(() => undefined)
  await admitted
  browser.abort()
  expect(f.saved.get(pendingKey)).toMatchObject({ phase: "waiting" })
  expect(f.transport).not.toHaveBeenCalled()
  release()
  await Promise.all([rotation, finish])
  observe.mockRestore()
  expect(f.saved.get(pendingKey)).toMatchObject({ phase: "waiting" })
  await f.finish()
  expect(f.transport).toHaveBeenCalledTimes(1)
})
