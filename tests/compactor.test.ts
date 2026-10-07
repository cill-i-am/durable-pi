import { describe, expect, it, vi } from "vitest"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import { database } from "./database"
import { MemoryStore, byteLength } from "../src/agent/memory"
import {
  cutUtf8,
  pumpSummaries,
  summarize,
  SCALE,
  type CompleteSummary,
} from "../src/agent/compactor"

const reply = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-responses",
  provider: "openai",
  model: "test",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 0,
})
const long = {
  start: 0,
  count: 1,
  source: "user: " + "x".repeat(600),
  context: "older context",
}

describe("OptChat compactor", () => {
  it("uses a 512-byte reference and a UTF-8-safe cut", () => {
    expect(byteLength(SCALE)).toBe(512)
    expect(cutUtf8("ab🍀z", 5)).toBe("ab")
    expect(cutUtf8("ab🍀z", 6)).toBe("ab🍀")
  })
  it("keeps short sources verbatim without a model call", async () => {
    const complete = vi.fn<CompleteSummary>()
    expect(
      await summarize({ ...long, source: "user: one\ntalk: two" }, complete)
    ).toBe("user: one\ntalk: two")
    expect(complete).not.toHaveBeenCalled()
  })
  it("retries in one conversation with byte-cut feedback and keeps the shortest of five", async () => {
    const lengths = [800, 600, 700, 550, 650],
      requests: number[] = [],
      feedback: string[] = []
    const result = await summarize(long, async ({ messages }) => {
      requests.push(messages.length)
      if (messages.length > 1) feedback.push(String(messages.at(-1)!.content))
      return reply("x".repeat(lengths[requests.length - 1]!))
    })
    expect(result).toHaveLength(550)
    expect(requests).toEqual([1, 3, 5, 7, 9])
    expect(feedback[0]).toContain("800 bytes")
    expect(feedback.every((text) => text.includes("| ← LIMIT"))).toBe(true)
  })
  it("rejects empty or failed responses instead of saving invented memory", async () => {
    await expect(summarize(long, async () => reply("  "))).rejects.toThrow(
      "Empty"
    )
    await expect(
      summarize(long, async () => ({
        ...reply("partial"),
        stopReason: "error",
      }))
    ).rejects.toThrow("unavailable")
  })
  it("allows eight ready merges in flight while preserving the leaf barrier", async () => {
    const memory = new MemoryStore(database())
    for (let i = 0; i < 18; i++) {
      memory.append(String(i), "user", "x".repeat(600))
      if (i < 16) memory.saveNode({ start: i, count: 1 }, "s".repeat(300))
    }
    const waiting: (() => void)[] = [],
      contexts: string[] = [],
      sizes: number[] = []
    let active = 0
    const pump = pumpSummaries(memory, async ({ messages }) => {
      active++
      sizes.push(active)
      contexts.push(JSON.stringify(messages))
      await new Promise<void>((resolve) => waiting.push(resolve))
      active--
      return reply("summary")
    })
    await vi.waitFor(() => expect(waiting.length).toBe(8))
    // Leaf 17 cannot start while leaf 16 is running, but earlier merges can.
    expect(memory.next(new Set(["16+1"]))).not.toMatchObject({
      start: 17,
      count: 1,
    })
    while (active || waiting.length) {
      waiting.splice(0).forEach((resolve) => resolve())
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    await pump
    expect(Math.max(...sizes)).toBe(8)
    expect(memory.settled()).toBe(true)
    expect(memory.nodeCount()).toBe(34)
    expect(contexts[0]).not.toContain("17+1")
  })
  it("persists a ten-second cooldown, reports once, and does not recompute finished nodes", async () => {
    const db = database(),
      memory = new MemoryStore(db),
      report = vi.fn()
    memory.append("a", "user", "x".repeat(600))
    memory.append("b", "user", "next")
    const fail = vi.fn<CompleteSummary>(async () => {
      throw new Error("provider secret error")
    })
    expect(await pumpSummaries(memory, fail, { now: () => 100, report })).toBe(
      10_100
    )
    expect(
      await pumpSummaries(new MemoryStore(db), fail, { now: () => 200, report })
    ).toBe(10_100)
    expect(fail).toHaveBeenCalledTimes(1)
    await pumpSummaries(memory, fail, { now: () => 10_100, report })
    expect(report).toHaveBeenCalledTimes(1)
    const good = vi.fn<CompleteSummary>(async () => reply("summary"))
    expect(
      await pumpSummaries(memory, good, { now: () => 20_100 })
    ).toBeUndefined()
    expect(good).toHaveBeenCalledTimes(1)
    expect(memory.render()).toContain("user: next")
    await pumpSummaries(new MemoryStore(db), good, { now: () => 30_100 })
    expect(good).toHaveBeenCalledTimes(1)
  })
})
