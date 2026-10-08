import { describe, expect, it } from "vitest"
import {
  canonicalOriginResponse,
  matchesSecret,
  sameOrigin,
} from "../src/auth/server"
import { decodeCredential, workerChatGPTAuth } from "../src/agent/models"

describe("private app boundaries", () => {
  it("redirects old bookmarks to the configured origin without an open redirect", () => {
    const response = canonicalOriginResponse(
      new Request("https://old.workers.dev//attacker.test/path?q=one"),
      "https://bot.example.com"
    )!
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe(
      "https://bot.example.com//attacker.test/path?q=one"
    )
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(
      canonicalOriginResponse(
        new Request("https://bot.example.com/"),
        "https://bot.example.com"
      )
    ).toBeUndefined()
    expect(
      canonicalOriginResponse(
        new Request("http://127.0.0.1:1337/"),
        "http://localhost:1337"
      )
    ).toBeUndefined()
  })
  it("rejects mutations on an old hostname instead of forwarding their bodies", () => {
    const response = canonicalOriginResponse(
      new Request("https://old.workers.dev/api/agent/send", {
        method: "POST",
        body: "private message",
      }),
      "https://bot.example.com"
    )!
    expect(response.status).toBe(403)
    expect(response.headers.has("location")).toBe(false)
  })
  it("requires an exact browser origin for mutations", () => {
    expect(
      sameOrigin(
        new Request("https://chat.example/api", {
          headers: { origin: "https://chat.example" },
        }),
        "https://chat.example"
      )
    ).toBe(true)
    for (const origin of [
      "https://chat.example.attacker.test",
      "null",
      "http://chat.example",
    ]) {
      expect(
        sameOrigin(
          new Request("https://chat.example/api", { headers: { origin } }),
          "https://chat.example"
        )
      ).toBe(false)
    }
    expect(
      sameOrigin(
        new Request("https://chat.example/api"),
        "https://chat.example"
      )
    ).toBe(false)
  })
  it("fails closed on missing or incorrect setup secrets", async () => {
    expect(await matchesSecret("", "")).toBe(false)
    expect(await matchesSecret("test-one", "test-two")).toBe(false)
    expect(await matchesSecret("test-one", "test-one")).toBe(true)
  })
  it("rejects malformed credentials before using them", () => {
    expect(() => decodeCredential({ type: "oauth", access: "test" })).toThrow()
    expect(() => decodeCredential({ type: "unknown", key: "test" })).toThrow()
  })
  it("does not return upstream token-response bodies in refresh errors", async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () =>
      new Response("sensitive upstream diagnostics", { status: 401 })
    try {
      await expect(
        workerChatGPTAuth.refresh(
          {
            type: "oauth",
            access: "test",
            refresh: "test",
            expires: 0,
            clientId: "test",
          },
          new AbortController().signal
        )
      ).rejects.toThrow("ChatGPT authorization expired")
    } finally {
      globalThis.fetch = original
    }
  })
})
