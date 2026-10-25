import {
  auth,
  StreamableHTTPClientTransport,
  type AuthOptions,
} from "@modelcontextprotocol/client"
import { Effect } from "effect"
import { describe, it, expect, vi } from "vitest"

import { ConnectionStore } from "../src/access/adapters/connections"
import {
  mcpConnectionClient,
  type McpManager,
} from "../src/access/adapters/mcp"
import { ConnectionOAuthProvider } from "../src/access/adapters/oauth"
import { database } from "./database"

const connectionId = `mcp-${"a".repeat(32)}`
const issuer = "https://auth.example.com",
  serverUrl = "https://mcp.example.com/mcp"
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
}
const resource = { resource: serverUrl, authorization_servers: [issuer] }
function discovery(url: string | URL | Request) {
  const target = String(url)
  return target.includes("oauth-protected-resource")
    ? Response.json(resource)
    : Response.json(metadata)
}
async function fixture() {
  const values = new Map<string, unknown>()
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => {
      values.set(key, value)
    },
    delete: async (key: string | string[]) => {
      for (const item of Array.isArray(key) ? key : [key]) values.delete(item)
    },
    list: async ({ prefix }: { prefix: string }) =>
      new Map([...values].filter(([key]) => key.startsWith(prefix))),
  } as unknown as DurableObjectStorage
  const store = new ConnectionStore(database())
  Effect.runSync(
    store.add({ id: connectionId, name: "Synthetic", url: serverUrl })
  )
  const provider = new ConnectionOAuthProvider(
    storage,
    store,
    "https://app.example.com/api/agent/connections/callback"
  )
  provider.serverId = connectionId
  await provider.saveClientInformation({ client_id: "synthetic", issuer })
  await provider.saveTokens({
    access_token: "synthetic-old",
    refresh_token: "synthetic-single-use",
    token_type: "Bearer",
    issuer,
  })
  await provider.saveDiscoveryState({
    authorizationServerUrl: issuer,
    authorizationServerMetadata: {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    },
    resourceMetadata: { resource: serverUrl, authorization_servers: [issuer] },
  })
  return { provider, store, values, storage }
}
describe("native MCP OAuth concurrency regression", () => {
  it("shares one rotating-token refresh across simultaneous requests and retains new credentials", async () => {
    const { provider } = await fixture()
    let refreshes = 0
    const fetchFn: NonNullable<AuthOptions["fetchFn"]> = async (_url, init) => {
      if (!String(_url).endsWith("/token")) return discovery(_url)
      const body = new URLSearchParams(String(init?.body))
      expect(body.get("refresh_token")).toBe("synthetic-single-use")
      refreshes++
      return refreshes === 1
        ? Response.json({
            access_token: "synthetic-new",
            refresh_token: "synthetic-rotated",
            token_type: "Bearer",
          })
        : Response.json({ error: "invalid_grant" }, { status: 400 })
    }
    expect(
      await Promise.all([
        auth(provider, { serverUrl, fetchFn }),
        auth(provider, { serverUrl, fetchFn }),
      ])
    ).toEqual(["AUTHORIZED", "AUTHORIZED"])
    expect(refreshes).toBe(1)
    expect((await provider.tokens())?.refresh_token).toBe("synthetic-rotated")
    expect((await provider.tokens())?.issuer).toBe(issuer)
  })
  it("serializes differing flow options without reusing a consumed token", async () => {
    const { provider } = await fixture(),
      received: string[] = []
    let pending = 0,
      peak = 0
    const fetchFn: NonNullable<AuthOptions["fetchFn"]> = async (_url, init) => {
      if (!String(_url).endsWith("/token")) return discovery(_url)
      pending++
      peak = Math.max(peak, pending)
      const body = new URLSearchParams(String(init?.body))
      received.push(body.get("refresh_token")!)
      await new Promise((resolve) => setTimeout(resolve, 5))
      pending--
      return Response.json({
        access_token: "synthetic-new",
        refresh_token: `synthetic-rotated-${received.length}`,
        token_type: "Bearer",
      })
    }
    await Promise.all([
      auth(provider, { serverUrl, fetchFn, scope: "read" }),
      auth(provider, {
        serverUrl,
        fetchFn,
        scope: "read",
        skipIssuerMetadataValidation: false,
      }),
    ])
    expect(peak).toBe(1)
    expect(received).toEqual(["synthetic-single-use", "synthetic-rotated-1"])
  })
  it("releases a failed flow for a later retry and keeps providers isolated", async () => {
    const { provider } = await fixture(),
      { provider: other } = await fixture()
    const savedDiscovery = provider.discoveryState.bind(provider)
    provider.discoveryState = async () => {
      throw new TypeError("Synthetic offline")
    }
    await expect(auth(provider, { serverUrl })).rejects.toThrow("offline")
    provider.discoveryState = savedDiscovery
    let calls = 0
    const fetchFn = async () => {
      calls++
      return Response.json({
        access_token: "synthetic-new",
        refresh_token: "synthetic-rotated",
        token_type: "Bearer",
      })
    }
    expect(
      await Promise.all([
        auth(provider, { serverUrl, fetchFn }),
        auth(other, { serverUrl, fetchFn }),
      ])
    ).toEqual(["AUTHORIZED", "AUTHORIZED"])
    expect(calls).toBe(2)
  })
  it("fences late token saves and invalidations after disconnect and reconnect", async () => {
    const { provider, store, storage, values } = await fixture()
    let release!: () => void, entered!: () => void
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    const refreshing = new Promise<void>((resolve) => {
      entered = resolve
    })
    const fetchFn: NonNullable<AuthOptions["fetchFn"]> = async (url) => {
      if (String(url).endsWith("/token")) {
        entered()
        await paused
        return Response.json({
          access_token: "synthetic-late",
          refresh_token: "synthetic-late-refresh",
          token_type: "Bearer",
        })
      }
      if (String(url) === serverUrl)
        return new Response(null, {
          status: 401,
          headers: { "www-authenticate": "Bearer" },
        })
      return discovery(url)
    }
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
      authProvider: provider,
      fetch: fetchFn,
    })
    await transport.start()
    const pending = transport
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "read", arguments: {} },
      })
      .catch(() => {})
    await refreshing
    Effect.runSync(store.change(connectionId, 1, false))
    await transport.close()
    await provider.clearServerStorage()
    release()
    await pending
    expect(
      [...values.values()].some(
        (value) =>
          typeof value === "object" && value !== null && "access_token" in value
      )
    ).toBe(false)
    Effect.runSync(store.change(connectionId, 2, true))
    const next = new ConnectionOAuthProvider(
      storage,
      store,
      "https://app.example.com/api/agent/connections/callback"
    )
    next.serverId = connectionId
    await next.saveClientInformation({ client_id: "synthetic", issuer })
    await next.saveTokens({
      access_token: "synthetic-reconnected",
      token_type: "Bearer",
      issuer,
    })
    await expect(provider.invalidateCredentials("tokens")).rejects.toThrow(
      "changed"
    )
    expect((await next.tokens())?.access_token).toBe("synthetic-reconnected")
  })
  it("keeps state one-use and PKCE verifier bound to its callback flow", async () => {
    const { provider } = await fixture()
    await provider.saveCodeVerifier("synthetic-verifier")
    const state = await provider.state()
    const challenge = Buffer.from(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode("synthetic-verifier")
      )
    ).toString("base64url")
    await provider.redirectToAuthorization(
      new URL(`${issuer}/authorize?state=${state}&code_challenge=${challenge}`)
    )
    expect((await provider.checkState(state)).valid).toBe(true)
    await provider.runWithCodeVerifierState(state, async () => {
      expect(await provider.codeVerifier()).toBe("synthetic-verifier")
      await provider.deleteCodeVerifier()
    })
    await provider.consumeState(state)
    expect((await provider.checkState(state)).valid).toBe(false)
  })
})

describe("connection generation owns pending OAuth state", () => {
  it("does not recapture a new generation when the SDK repeats the same server assignment", async () => {
    const { provider, store } = await fixture()
    Effect.runSync(store.change(connectionId, 1, false))
    Effect.runSync(store.change(connectionId, 2, true))
    provider.serverId = connectionId
    await expect(provider.state()).rejects.toThrow("changed")
    await expect(
      provider.saveTokens({ access_token: "stale", token_type: "Bearer" })
    ).rejects.toThrow("changed")
  })
  it("rejects old pending state and PKCE after reconnect even when SDK cleanup left every key", async () => {
    const { provider, store, storage, values } = await fixture()
    await provider.saveCodeVerifier("synthetic-old-verifier")
    const state = await provider.state()
    const challenge = Buffer.from(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode("synthetic-old-verifier")
      )
    ).toString("base64url")
    await provider.redirectToAuthorization(
      new URL(`${issuer}/authorize?state=${state}&code_challenge=${challenge}`)
    )
    const retained = values.size
    Effect.runSync(store.change(connectionId, 1, false))
    Effect.runSync(store.change(connectionId, 2, true))
    const next = new ConnectionOAuthProvider(
      storage,
      store,
      "https://app.example.com/api/agent/connections/callback"
    )
    next.serverId = connectionId
    next.clientId = "synthetic"
    expect((await next.checkState(state)).valid).toBe(false)
    await expect(
      next.runWithCodeVerifierState(state, () => next.codeVerifier())
    ).rejects.toThrow("No code verifier")
    expect(values.size).toBe(retained)
    expect((await next.tokens())?.access_token).toBe("synthetic-old")
    expect((await next.checkState(await next.state())).valid).toBe(true)
  })
  it("keeps legacy credentials but rejects unversioned pending authorization", async () => {
    const { provider, values } = await fixture()
    const nonce = "legacy-nonce",
      state = `${nonce}.${connectionId}`
    values.set(`/Durable Pi/${connectionId}/state/${nonce}`, {
      nonce,
      serverId: connectionId,
      createdAt: Date.now(),
    })
    values.set(
      `/Durable Pi/${connectionId}/synthetic/code_verifier`,
      "legacy-verifier"
    )
    expect((await provider.checkState(state)).valid).toBe(false)
    await expect(
      provider.runWithCodeVerifierState(state, () => provider.codeVerifier())
    ).rejects.toThrow("No code verifier")
    expect((await provider.tokens())?.access_token).toBe("synthetic-old")
  })
})

it.each(["authenticating", "connected", "ready"])(
  "rejects a stale callback before the native manager sees it while %s",
  async (phase) => {
    const { provider, store, storage } = await fixture()
    const state = await provider.state()
    // Deliberately retain storage to represent SDK cleanup failure.
    Effect.runSync(store.change(connectionId, 1, false))
    Effect.runSync(store.change(connectionId, 2, true))
    const next = new ConnectionOAuthProvider(
      storage,
      store,
      "https://app.example.com/api/agent/connections/callback"
    )
    next.serverId = connectionId
    const callback = vi.fn(async () => ({
      authSuccess: true,
      serverId: connectionId,
    }))
    const manager = {
      mcpConnections: {
        [connectionId]: {
          connectionState: phase,
          options: { transport: { authProvider: next } },
        },
      },
      handleCallbackRequest: callback,
    } as unknown as McpManager
    const client = mcpConnectionClient(manager)
    const outcome = await Effect.runPromiseExit(
      client.callback(
        new Request(
          `https://app.example.com/api/agent/connections/callback?code=synthetic&state=${state}`
        ),
        () => true
      )
    )
    expect(outcome._tag).toBe("Failure")
    expect(callback).not.toHaveBeenCalled()
    const current = await next.state()
    expect(
      await Effect.runPromise(
        client.callback(
          new Request(
            `https://app.example.com/api/agent/connections/callback?code=synthetic&state=${current}`
          ),
          () => true
        )
      )
    ).toEqual({ authenticated: true, connectionId, revision: 3 })
    expect(callback).toHaveBeenCalledTimes(1)
  }
)
it("checks the family receipt after delayed callback state validation", async () => {
  const { provider } = await fixture(),
    state = await provider.state()
  let authorized = true
  const check = provider.callbackRevision.bind(provider)
  provider.callbackRevision = async (state) => {
    const revision = await check(state)
    authorized = false
    return revision
  }
  const callback = vi.fn(async () => ({
    authSuccess: true,
    serverId: connectionId,
  }))
  const manager = {
    mcpConnections: {
      [connectionId]: { options: { transport: { authProvider: provider } } },
    },
    handleCallbackRequest: callback,
  } as unknown as McpManager
  expect(
    (
      await Effect.runPromiseExit(
        mcpConnectionClient(manager).callback(
          new Request(
            `https://app.example.com/api/agent/connections/callback?code=synthetic&state=${state}`
          ),
          () => authorized
        )
      )
    )._tag
  ).toBe("Failure")
  expect(callback).not.toHaveBeenCalled()
})
