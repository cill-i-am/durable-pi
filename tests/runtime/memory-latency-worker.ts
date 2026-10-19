import { DurableObject } from "cloudflare:workers"
import { Effect, Scope } from "effect"

import { makeSqliteMemory } from "../../src/memory/adapters/sqlite"
import { byteLength } from "../../src/memory/domain"
import { renderMemory } from "../../src/memory/policy"
import { nativeDatabase } from "./database"

export class MemoryLatencyProbe extends DurableObject {
  readonly scope = Scope.makeUnsafe()
  readonly db = nativeDatabase(this.ctx.storage, this.scope)
  readonly memory = Effect.runSync(makeSqliteMemory(this.db))
  async fetch(request: Request) {
    const path = new URL(request.url).pathname
    const result = await Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const memory = this.memory
        if (path === "/growth") {
          for (let id = 0; id < 300; id++) {
            yield* memory.append(`normal-${id}`, "user", "x".repeat(1024))
            yield* memory.saveNode({ start: id, count: 1 }, "s".repeat(512))
            for (let count = 2; (id + 1) % count === 0; count *= 2)
              yield* memory.saveNode(
                { start: id + 1 - count, count },
                "s".repeat(512)
              )
          }
          return {
            total: yield* memory.total(),
            parts: (yield* memory.parts()).length,
          }
        }
        if (path === "/rollback") {
          this.ctx.storage.transactionSync(() => {
            this.db.run("DELETE FROM memory_view")
            this.db.run("INSERT INTO memory_view SELECT id,1 FROM memory_log")
            this.db.run(
              "CREATE TRIGGER fail_second_batch BEFORE INSERT ON memory_view WHEN (SELECT count(*) FROM memory_view) = 32 AND NEW.start < 300 BEGIN SELECT RAISE(ABORT, 'injected second batch failure'); END"
            )
          })
          const before = yield* memory.parts(),
            total = yield* memory.total()
          const result = yield* memory
            .append("rollback-test", "user", "test")
            .pipe(Effect.result)
          this.db.run("DROP TRIGGER fail_second_batch")
          return {
            failed: result._tag === "Failure",
            rolledBack:
              total === (yield* memory.total()) &&
              JSON.stringify(before) === JSON.stringify(yield* memory.parts()),
          }
        }
        if (path === "/restore") {
          const entries = Array.from({ length: 300 }, (_, id) => ({
            type: "message" as const,
            id,
            source: `restored-${id}`,
            kind: "user" as const,
            text: `entry ${id}`,
            date: "2026-10-19T00:00:00Z",
          }))
          const parts = entries.map((entry) => ({ start: entry.id, count: 1 }))
          yield* memory.restore(entries, parts)
          // Exercise bootstrap/rebuild batches on an existing large archive too.
          this.db.run(
            "DELETE FROM memory_migrations WHERE name='effect-memory-v1'"
          )
          this.db.run("DELETE FROM memory_compaction_view")
          this.db.run("DELETE FROM memory_view_state WHERE id=2")
          const reopened = yield* makeSqliteMemory(this.db)
          return {
            total: yield* reopened.total(),
            parts: (yield* reopened.parts()).length,
            ready: this.db.all<{ n: number }>(
              "SELECT count(*) AS n FROM memory_ready"
            )[0]!.n,
          }
        }
        if (path === "/pending") {
          const text = "\0" + "🍀\n".repeat(6000)
          this.ctx.storage.transactionSync(() => {
            this.db.run(
              "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i+1<4096) INSERT INTO memory_log(id,source,kind,text,date) SELECT i,'pending-'||i,'tool',?,'2026-10-19T00:00:00Z' FROM n",
              text
            )
            this.db.run("INSERT INTO memory_view SELECT id,1 FROM memory_log")
          })
          const parts = yield* memory.parts()
          const originals = new Map(
            parts.map((part) => [
              part.start,
              {
                id: part.start,
                kind: "tool" as const,
                text,
                source: "",
                date: "",
              },
            ])
          )
          const rendered = yield* memory.render()
          return {
            exact: rendered === renderMemory(parts, new Map(), originals),
            bytes: byteLength(rendered),
            archiveExact: (yield* memory.entry(4095))?.text === text,
          }
        }
        throw new Error("Unknown memory probe")
      })
    )
    return Response.json(result)
  }
}
interface Env {
  PROBES: DurableObjectNamespace<MemoryLatencyProbe>
}
export default {
  fetch(request: Request, env: Env) {
    const path = new URL(request.url).pathname
    if (path === "/health") return new Response("ok")
    return env.PROBES.getByName(path === "/rollback" ? "/growth" : path).fetch(
      request
    )
  },
}
