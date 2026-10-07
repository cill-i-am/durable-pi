import { describe, expect, it } from "vitest"
import { DurableCredentials } from "../src/agent/models"
import { database } from "./database"

describe("private model credentials", () => {
  const seed = JSON.stringify({
    type: "oauth",
    access: "test-access",
    refresh: "test-refresh",
    expires: 0,
    clientId: "test-client",
  })
  it("serializes refresh and persists rotated tokens through an object restart", async () => {
    const db = database(),
      store = new DurableCredentials(db, seed)
    const seen: string[] = []
    await Promise.all(
      [1, 2].map((i) =>
        store.modify("openai", async (current) => {
          if (current?.type !== "oauth") throw new Error("Missing credential")
          seen.push(current.refresh)
          await Promise.resolve()
          return { ...current, refresh: `rotated-${i}` }
        })
      )
    )
    expect(seen).toEqual(["test-refresh", "rotated-1"])
    expect(await new DurableCredentials(db, seed).read("openai")).toMatchObject(
      { refresh: "rotated-2" }
    )
    expect(await store.list()).toEqual([
      { providerId: "openai", type: "oauth" },
    ])
  })
  it("only replaces credentials when the deployment seed changes", async () => {
    const db = database(),
      store = new DurableCredentials(db, seed)
    await store.read("openai")
    const next = JSON.stringify({ type: "api_key", key: "test-replacement" })
    expect(await new DurableCredentials(db, next).read("openai")).toEqual({
      type: "api_key",
      key: "test-replacement",
    })
  })
})
