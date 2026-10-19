import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"

import { makeSqliteMemory } from "../src/memory/adapters/sqlite"
import {
  byteLength,
  fitView,
  nodeKey,
  type MemoryNode,
  type Part,
  type LogEntry,
} from "../src/memory/domain"
import { renderMemory } from "../src/memory/policy"
import { database } from "./database"

// Deliberately simple reference for the original greedy policy. It catches
// changes to merge order, ties, gaps and unavailable parents independently of
// the optimized heap/linked-list implementation.
function referenceFit(
  parts: Part[],
  total: number,
  nodes: Map<string, MemoryNode>,
  budget: number
) {
  const view = [...parts]
  const size = (part: Part) => nodes.get(nodeKey(part))?.bytes ?? 0
  let bytes = view.reduce((sum, part) => sum + size(part), 0)
  while (bytes > budget) {
    let best = -1,
      score = -1
    for (let i = 0; i < view.length - 1; i++) {
      const a = view[i]!,
        b = view[i + 1]!
      if (
        a.count !== b.count ||
        a.start % (a.count * 2) !== 0 ||
        b.start !== a.start + a.count ||
        !nodes.has(nodeKey({ start: a.start, count: a.count * 2 }))
      )
        continue
      const due = (total - (a.start + 2 * a.count - 1)) / a.count
      if (due > score) {
        best = i
        score = due
      }
    }
    if (best < 0) break
    const a = view[best]!,
      b = view[best + 1]!,
      parent = { start: a.start, count: a.count * 2 }
    bytes += size(parent) - size(a) - size(b)
    view.splice(best, 2, parent)
  }
  return view
}

it.effect(
  "retains greedy merge ordering with variable sizes, missing parents and repeated fits",
  () =>
    Effect.gen(function* () {
      let seed = 20261019
      const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        return seed / 2 ** 32
      }
      for (let fixture = 0; fixture < 300; fixture++) {
        const total = 2 + Math.floor(random() * 254),
          nodes = new Map<string, MemoryNode>()
        const parts = Array.from({ length: total }, (_, start) => ({
          start,
          count: 1,
        }))
        for (let count = 1; count <= total; count *= 2)
          for (let start = 0; start + count <= total; start += count) {
            if (random() < 0.16) continue
            const part = {
              start,
              count,
              text: "",
              bytes: Math.floor(random() * 1200),
            }
            nodes.set(nodeKey(part), part)
          }
        const budget = Math.floor(random() * total * 400)
        const expected = referenceFit(parts, total, nodes, budget)
        expect(yield* fitView(parts, total, nodes, budget)).toEqual(expected)
        expect(yield* fitView(expected, total, nodes, budget / 2)).toEqual(
          referenceFit(expected, total, nodes, budget / 2)
        )
        expect(parts).toHaveLength(total)
      }
    })
)

it.effect(
  "merges 16,384 leaves without a quadratic number of node lookups",
  () =>
    Effect.gen(function* () {
      const total = 16384,
        nodes = new Map<string, MemoryNode>()
      for (let count = 1; count <= total; count *= 2)
        for (let start = 0; start + count <= total; start += count)
          nodes.set(`${start}+${count}`, {
            start,
            count,
            text: "s".repeat(512),
            bytes: 512,
          })
      let lookups = 0
      const get = nodes.get.bind(nodes)
      nodes.get = (key) => {
        lookups++
        return get(key)
      }
      const parts = Array.from({ length: total }, (_, start) => ({
        start,
        count: 1,
      }))
      const view = yield* fitView(parts, total, nodes, 64000)
      expect(view.reduce((sum, part) => sum + part.count, 0)).toBe(total)
      expect(view.length * 512).toBeLessThanOrEqual(64000)
      expect(lookups).toBeLessThan(total * 8)
    })
)

it.effect(
  "bounds text materialization and preserves exact prompt bytes including Unicode and NUL",
  () =>
    Effect.gen(function* () {
      const patterns = [
        "",
        "a",
        "€42.75 🍀 中 ",
        "\n",
        "𝒜\u0301",
        "\0nul\0",
        "short",
      ]
      for (let fixture = 0; fixture < 18; fixture++) {
        const db = database(),
          memory = yield* makeSqliteMemory(db)
        const originals = new Map<number, LogEntry>(),
          nodes = new Map<string, MemoryNode>()
        const total = fixture === 17 ? 4096 : 80
        for (let id = 0; id < total; id++) {
          const text =
            fixture === 17
              ? "\0" + "🍀".repeat(7500)
              : patterns[(id + fixture) % patterns.length]!.repeat(
                  [0, 1, 31, 201, 4096, 5001, 17000][(id * 3 + fixture) % 7]!
                )
          const entry: LogEntry = {
            id,
            source: `seed-${id}`,
            kind: "tool",
            text,
            date: "2026-10-19T00:00:00Z",
          }
          originals.set(id, entry)
          db.run(
            "INSERT INTO memory_log(id,source,kind,text,date) VALUES(?,?,'tool',?,?)",
            id,
            entry.source,
            text,
            entry.date
          )
          db.run("INSERT INTO memory_view VALUES(?,1)", id)
          if (id % 3 === 0 && fixture < 17) {
            const summary =
              id === 0 && fixture > 10
                ? "s".repeat(119000 + fixture * 23)
                : `summary ${id}`
            const node = {
              start: id,
              count: 1,
              text: summary,
              bytes: byteLength(summary),
            }
            nodes.set(nodeKey(node), node)
            db.run(
              "INSERT INTO memory_nodes(start,count,text,bytes) VALUES(?,1,?,?)",
              id,
              summary,
              node.bytes
            )
          }
        }
        const parts = yield* memory.parts()
        let materialized = 0
        const use = db.use
        db.use = (body) =>
          use(body).pipe(
            Effect.tap((rows) =>
              Effect.sync(() => {
                if (Array.isArray(rows))
                  for (const row of rows) {
                    if (
                      row &&
                      typeof row === "object" &&
                      "hex" in row &&
                      typeof row.hex === "string"
                    )
                      materialized += row.hex.length / 2
                  }
              })
            )
          )
        expect(yield* memory.render()).toBe(
          renderMemory(parts, nodes, originals)
        )
        expect(materialized).toBeLessThanOrEqual(8192 + 8 * 8192)
        expect((yield* memory.entry(total - 1))?.text).toBe(
          originals.get(total - 1)!.text
        )
      }
    })
)

it.effect("preserves a leading byte-order mark in pending originals", () =>
  Effect.gen(function* () {
    const memory = yield* makeSqliteMemory(database())
    const original = "\uFEFFfile contents"
    yield* memory.append("bom", "user", original)
    expect(yield* memory.render()).toBe(
      `<chat>\n0+0|user: ${original}\n</chat>`
    )
    expect((yield* memory.entry(0))?.text).toBe(original)
  })
)
