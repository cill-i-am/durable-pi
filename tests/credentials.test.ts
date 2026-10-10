import { describe, expect, it } from "vitest"
import {
  DurableCredentials,
  accountCredentials,
  resolveAccountCredential,
} from "../src/agent/models"
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
  it("coalesces concurrent bot refreshes at the account and never stores child tokens", async () => {
    const store = new DurableCredentials(
      database(),
      JSON.stringify({ ...JSON.parse(seed), expires: Date.now() + 120_000 })
    )
    let refreshes = 0
    const resolve = (provider: string) =>
      resolveAccountCredential(store, provider, async (current) => {
        refreshes++
        await Promise.resolve()
        return {
          ...current,
          access: "rotated-access",
          refresh: "rotated-refresh",
          expires: Date.now() + 600_000,
        }
      })
    const bots = [accountCredentials(resolve), accountCredentials(resolve)]
    const results = await Promise.all(bots.map((bot) => bot.read("openai")))
    expect(refreshes).toBe(1)
    expect(results).toEqual([
      expect.objectContaining({ access: "rotated-access" }),
      expect.objectContaining({ access: "rotated-access" }),
    ])
    await bots[0]!.modify("openai", async () => {
      throw new Error("Child must not refresh")
    })
    expect(refreshes).toBe(1)
    await expect(bots[0]!.delete("openai")).rejects.toThrow("owner account")
  })
})
