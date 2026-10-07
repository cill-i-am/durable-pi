import { database } from "./database"
import { describe, expect, it } from "vitest"
import {
  MemoryStore,
  byteLength,
  fitView,
  type MemoryNode,
} from "../src/agent/memory"

describe("lossless memory", () => {
  it("deduplicates durable appends and retrieves original Unicode text", () => {
    const memory = new MemoryStore(database())
    const original = "🍀\n".repeat(1000)
    memory.append("one", "user", original)
    memory.append("one", "user", original)
    expect(memory.total()).toBe(1)
    expect(() => memory.render()).toThrow("summarized")
    memory.saveNode({ start: 0, count: 1 }, "user: clovers")
    expect(memory.zoom(0, 1)).toBe(`0+0|user: ${original}`)
    expect(byteLength("🍀")).toBe(4)
  })
  it("compresses raw messages in order with complete prior context", () => {
    const memory = new MemoryStore(database())
    memory.append("a", "user", "first")
    memory.append("b", "user", "second")
    expect(memory.next()).toMatchObject({ start: 0, count: 1, context: "" })
    memory.saveNode({ start: 0, count: 1 }, "user: first")
    expect(memory.next()).toMatchObject({
      start: 1,
      count: 1,
      context: "user: first",
    })
    memory.saveNode({ start: 1, count: 1 }, "user: second")
    expect(memory.next()).toMatchObject({
      start: 0,
      count: 2,
      source: "user: first\nuser: second",
    })
  })
  it("only coarsens aligned built siblings and preserves a complete tiling across restart", () => {
    const db = database(),
      memory = new MemoryStore(db, 30)
    for (let i = 0; i < 8; i++) memory.append(String(i), "user", `message ${i}`)
    while (memory.next()) {
      const n = memory.next()!
      memory.saveNode(n, `${n.start}:${n.count}`)
    }
    const before = memory.parts()
    const reopened = new MemoryStore(db, 30)
    expect(reopened.parts()).toEqual(before)
    expect(before.reduce((n, p) => n + p.count, 0)).toBe(8)
    for (let i = 0; i < 8; i++)
      expect(reopened.zoom(i, 1)).toContain(`message ${i}`)
    expect(() => reopened.zoom(1, 2)).toThrow()
  })
  it("waits for a parent without truncating or merging unrelated ranges", () => {
    const a: MemoryNode = { start: 0, count: 1, text: "large", bytes: 5 }
    const b: MemoryNode = { start: 1, count: 1, text: "large", bytes: 5 }
    expect(
      fitView(
        [a, b],
        2,
        new Map([
          ["0+1", a],
          ["1+1", b],
        ]),
        1
      )
    ).toHaveLength(2)
  })
  it("requires memory notes to cite existing evidence", () => {
    const memory = new MemoryStore(database())
    expect(() => memory.writeNote("preferences.md", "likes tea", 0)).toThrow()
    memory.append("a", "user", "I like tea")
    memory.writeNote("preferences.md", "- Likes tea [source: message:0]", 0)
    expect(memory.notes()).toHaveLength(1)
    expect(() => memory.writeNote("../secrets.md", "bad", 0)).toThrow()
  })
})

it("bounds a large view by age without splitting earlier ranges on the next turn", () => {
  const total = 4096,
    nodes = new Map<string, MemoryNode>()
  for (let count = 1; count <= total; count *= 2)
    for (let start = 0; start + count <= total; start += count)
      nodes.set(`${start}+${count}`, {
        start,
        count,
        text: "s".repeat(512),
        bytes: 512,
      })
  const parts = Array.from({ length: total }, (_, start) => ({
    start,
    count: 1,
  }))
  const fitted = fitView(parts, total, nodes, 128_000)
  expect(
    fitted.reduce((n, p) => n + nodes.get(`${p.start}+${p.count}`)!.bytes, 0)
  ).toBeLessThanOrEqual(128_000)
  expect(fitted.reduce((n, p) => n + p.count, 0)).toBe(total)
  expect(fitted[0]!.count).toBeGreaterThan(fitted.at(-1)!.count)
  const next = fitView(
    [...fitted, { start: total, count: 1 }],
    total + 1,
    nodes,
    128_000
  )
  for (const old of fitted)
    expect(
      next.some(
        (p) =>
          p.start <= old.start && p.start + p.count >= old.start + old.count
      )
    ).toBe(true)
})
