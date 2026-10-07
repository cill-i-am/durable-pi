import { describe, expect, it } from "vitest"
import { matchesSecret, sameOrigin } from "../src/auth/server"
import { decodeCredential, workerChatGPTAuth } from "../src/agent/models"

describe("private app boundaries", () => {
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
