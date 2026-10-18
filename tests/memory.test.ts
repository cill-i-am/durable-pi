import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { makeSqliteMemory } from "../src/memory/adapters/sqlite"
import { byteLength, fitView, type MemoryNode } from "../src/memory/domain"
import { migrateSqlite } from "../src/storage/migrations"
import { database } from "./database"

describe("lossless memory", () => {
  it("deduplicates durable appends and retrieves original Unicode text", () => {
    const memory = Effect.runSync(makeSqliteMemory(database()))
    const original = "🍀\n".repeat(100)
    Effect.runSync(memory.append("one", "user", original))
    Effect.runSync(memory.append("one", "user", original))
    expect(Effect.runSync(memory.total())).toBe(1)
    expect(Effect.runSync(memory.render())).toContain(original)
    expect(Effect.runSync(memory.settled())).toBe(false)
    Effect.runSync(memory.saveNode({ start: 0, count: 1 }, "user: clovers"))
    expect(Effect.runSync(memory.zoom(0, 1))).toBe(`0+0|user: ${original}`)
    expect(byteLength("🍀")).toBe(4)
  })
  it("compresses raw messages in order with complete prior context", () => {
    const memory = Effect.runSync(makeSqliteMemory(database()))
    Effect.runSync(memory.append("a", "user", "first"))
    Effect.runSync(memory.append("b", "user", "second"))
    expect(Effect.runSync(memory.next())).toMatchObject({
      start: 0,
      count: 1,
      context: "",
    })
    Effect.runSync(memory.saveNode({ start: 0, count: 1 }, "user: first"))
    expect(Effect.runSync(memory.next())).toMatchObject({
      start: 1,
      count: 1,
      context: "0+1|user: first",
    })
    Effect.runSync(memory.saveNode({ start: 1, count: 1 }, "user: second"))
    expect(Effect.runSync(memory.next())).toMatchObject({
      start: 0,
      count: 2,
      source: "user: first\nuser: second",
    })
  })
  it("only coarsens aligned built siblings and preserves a complete tiling across restart", () => {
    const db = database(),
      memory = Effect.runSync(makeSqliteMemory(db, 30))
    for (let i = 0; i < 8; i++)
      Effect.runSync(memory.append(String(i), "user", `message ${i}`))
    while (Effect.runSync(memory.next())) {
      const n = Effect.runSync(memory.next())!
      Effect.runSync(memory.saveNode(n, `${n.start}:${n.count}`))
    }
    const before = Effect.runSync(memory.parts())
    const reopened = Effect.runSync(makeSqliteMemory(db, 30))
    expect(Effect.runSync(reopened.parts())).toEqual(before)
    expect(before.reduce((n, p) => n + p.count, 0)).toBe(8)
    for (let i = 0; i < 8; i++)
      expect(Effect.runSync(reopened.zoom(i, 1))).toContain(`message ${i}`)
    expect(() => Effect.runSync(reopened.zoom(1, 2))).toThrow()
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
    const memory = Effect.runSync(makeSqliteMemory(database()))
    expect(() =>
      Effect.runSync(memory.writeNote("preferences.md", "likes tea", 0))
    ).toThrow()
    Effect.runSync(memory.append("a", "user", "I like tea"))
    Effect.runSync(
      memory.writeNote("preferences.md", "- Likes tea [source: message:0]", 0)
    )
    expect(Effect.runSync(memory.notes())).toHaveLength(1)
    expect(() =>
      Effect.runSync(memory.writeNote("../secrets.md", "bad", 0))
    ).toThrow()
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

it("merges the recent pair at T=10, preserving the old cache prefix", () => {
  const parts = [
    { start: 0, count: 4 },
    { start: 4, count: 4 },
    { start: 8, count: 1 },
    { start: 9, count: 1 },
  ]
  const nodes = new Map<string, MemoryNode>()
  for (const part of [...parts, { start: 0, count: 8 }, { start: 8, count: 2 }])
    nodes.set(`${part.start}+${part.count}`, {
      ...part,
      text: "x".repeat(16),
      bytes: 16,
    })
  expect(fitView(parts, 10, nodes, 48)).toEqual([
    { start: 0, count: 4 },
    { start: 4, count: 4 },
    { start: 8, count: 2 },
  ])
})

it("batches at the high watermark, halves the view, and only appends between batches", () => {
  const memory = Effect.runSync(makeSqliteMemory(database(), 128))
  const settle = () => {
    for (;;) {
      const job = Effect.runSync(memory.next())
      if (!job) break
      Effect.runSync(memory.saveNode(job, "s".repeat(16)))
    }
  }
  for (let i = 0; i < 8; i++) {
    Effect.runSync(memory.append(String(i), "user", "original"))
    settle()
    expect(Effect.runSync(memory.parts())).toHaveLength(i + 1)
  }
  Effect.runSync(memory.append("8", "user", "original"))
  settle()
  expect(Effect.runSync(memory.parts())).toHaveLength(4)
  for (let i = 9; i < 13; i++) {
    const prefix = Effect.runSync(memory.render()).slice(0, -"\n</chat>".length)
    Effect.runSync(memory.append(String(i), "user", "original"))
    settle()
    expect(Effect.runSync(memory.render()).startsWith(prefix + "\n")).toBe(true)
  }
  expect(Effect.runSync(memory.parts())).toHaveLength(8)
})

it("resumes an unfinished batch after restart even below its high watermark", () => {
  const db = database()
  const memory = Effect.runSync(makeSqliteMemory(db, 128))
  for (let i = 0; i < 9; i++) {
    Effect.runSync(memory.append(String(i), "user", "original"))
    Effect.runSync(memory.saveNode({ start: i, count: 1 }, "s".repeat(16)))
  }
  Effect.runSync(memory.saveNode({ start: 0, count: 2 }, "s".repeat(16)))
  expect(Effect.runSync(memory.parts())).toHaveLength(8)
  const before = Effect.runSync(memory.parts())
  const reopened = Effect.runSync(makeSqliteMemory(db, 128))
  expect(Effect.runSync(reopened.parts())).toEqual(before)
  for (;;) {
    const job = Effect.runSync(reopened.next())
    if (!job) break
    Effect.runSync(reopened.saveNode(job, "s".repeat(16)))
  }
  expect(Effect.runSync(reopened.parts())).toHaveLength(4)
})

it("rebuilds derived queues without rewriting a persisted view", () => {
  const db = database(),
    memory = Effect.runSync(makeSqliteMemory(db, 128))
  for (let i = 0; i < 4; i++) {
    Effect.runSync(memory.append(String(i), "user", "original"))
    Effect.runSync(memory.saveNode({ start: i, count: 1 }, "leaf"))
  }
  const before = Effect.runSync(memory.parts())
  for (const table of [
    "memory_ready",
    "memory_migrations",
    "memory_compaction_view",
    "memory_view_state",
  ])
    db.run(`DELETE FROM ${table}`)
  Effect.runSync(migrateSqlite(db))
  const upgraded = Effect.runSync(makeSqliteMemory(db, 128))
  expect(Effect.runSync(upgraded.parts())).toEqual(before)
  expect(Effect.runSync(upgraded.next())).toMatchObject({ start: 0, count: 2 })
  Effect.runSync(upgraded.saveNode({ start: 0, count: 2 }, "parent"))
  const reopened = Effect.runSync(makeSqliteMemory(db, 128))
  expect(Effect.runSync(reopened.next())).toMatchObject({ start: 2, count: 2 })
})

it("keeps Effects lazy and returns a typed storage error without exposing driver data", () => {
  const db = database(),
    memory = Effect.runSync(makeSqliteMemory(db))
  const append = memory.append("a", "user", "message")
  expect(Effect.runSync(memory.total())).toBe(0)
  Effect.runSync(append)
  expect(Effect.runSync(memory.total())).toBe(1)
  db.run("DROP TABLE memory_view_state")
  const failing = Effect.runSync(makeSqliteMemory(db).pipe(Effect.flip))
  expect(failing).toMatchObject({
    _tag: "MemoryStorageError",
    operation: "query",
  })
  expect(JSON.stringify(failing)).not.toContain("private driver payload")
})

it("uses saved summaries alongside pending originals without publishing synthetic summary nodes", () => {
  const db = database(),
    memory = Effect.runSync(makeSqliteMemory(db))
  Effect.runSync(memory.append("older", "user", "Old raw message"))
  Effect.runSync(memory.saveNode({ start: 0, count: 1 }, "Saved older summary"))
  Effect.runSync(
    memory.append("recent", "talk", "Recent exact reply €42.75 🍀")
  )
  const before = Effect.runSync(memory.watermark())
  const rendered = Effect.runSync(memory.render())
  expect(rendered).toContain("0+1|Saved older summary")
  expect(rendered).toContain("1+0|talk: Recent exact reply €42.75 🍀")
  expect(rendered).not.toContain("Old raw message")
  expect(Effect.runSync(memory.watermark())).toEqual(before)
  expect(Effect.runSync(Effect.runSync(makeSqliteMemory(db)).render())).toBe(
    rendered
  )
})

it("bounds unsummarized working context, marks omissions and preserves complete originals", () => {
  const memory = Effect.runSync(makeSqliteMemory(database()))
  Effect.runSync(memory.append("older", "user", "Old entry"))
  const original =
    "Beginning €42.75 🍀 " + "中🍀".repeat(40_000) + " Latest detail"
  Effect.runSync(memory.append("huge", "echo", original))
  const rendered = Effect.runSync(memory.render())
  expect(byteLength(rendered)).toBeLessThanOrEqual(4_300)
  expect(rendered).toContain("Working context is abbreviated")
  expect(rendered).toContain("Beginning €42.75 🍀")
  expect(rendered).toContain("Latest detail")
  expect(rendered).not.toContain("�")
  expect(Effect.runSync(memory.zoom(1, 1))).toBe(`1+0|echo: ${original}`)
})

it("keeps the saved-summary prefix and bounds pending originals across a stalled backlog", () => {
  const memory = Effect.runSync(makeSqliteMemory(database()))
  Effect.runSync(memory.append("saved", "user", "Older important preference"))
  Effect.runSync(
    memory.saveNode({ start: 0, count: 1 }, "user: Keep exact amounts")
  )
  const prefix = Effect.runSync(memory.render()).slice(0, -"\n</chat>".length)
  const originals = Array.from(
    { length: 12 },
    (_, i) => `Start ${i} €42.75 🍀 ` + "中🍀".repeat(10_000) + ` End ${i}`
  )
  for (const [i, original] of originals.entries())
    Effect.runSync(memory.append(`pending-${i}`, "echo", original))
  const rendered = Effect.runSync(memory.render())
  expect(rendered.startsWith(prefix + "\n")).toBe(true)
  expect(byteLength(rendered)).toBeLessThanOrEqual(8_400)
  expect(rendered).toContain("Working context is abbreviated")
  expect(rendered).toContain("Start 11 €42.75 🍀")
  expect(rendered).toContain("End 11")
  expect(rendered).not.toContain("�")
  for (const [i, original] of originals.entries())
    expect(Effect.runSync(memory.zoom(i + 1, 1))).toBe(
      `${i + 1}+0|echo: ${original}`
    )
})
