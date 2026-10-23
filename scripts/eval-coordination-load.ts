import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"

import { sql } from "drizzle-orm"
import { Effect, Schema } from "effect"

import { agentMessages } from "../src/coordination/adapters/schema"
import { CoordinationStore } from "../src/coordination/adapters/sqlite"
import { Message, type Agent } from "../src/coordination/contracts"
import {
  AgentCoordination,
  type CoordinationHost,
} from "../src/coordination/service"
import { migrateSqlite } from "../src/storage/migrations"
import { makeNodeSqlite } from "../src/storage/node"

// Bounded, synthetic, local SQLite/store benchmark. No model or external IO.
// Throughput excludes inference, Workers scheduling, network and provider costs.
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] ?? 0
const round = (n: number) => Math.round(n * 100) / 100
const payload =
  process.env.COORDINATION_PAYLOAD === "max"
    ? "界".repeat(8000)
    : "x".repeat(512)

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const db = yield* makeNodeSqlite()
      yield* migrateSqlite(db)
      const store = new CoordinationStore(db)
      const agents: Agent[] = Array.from({ length: 100 }, (_, n) => ({
        address: { sessionId: `session-${n}`, agentId: "main" },
        nativeId: n,
        name: `Synthetic ${n}`,
        role: "main",
        status: "idle",
      }))
      const delivered: string[] = []
      const host: CoordinationHost = {
        bot: "synthetic-load",
        enabled: () => Effect.succeed(true),
        source: (n) => Effect.succeed(agents[n]),
        agents: (id) =>
          Effect.succeed(agents.filter((a) => a.address.sessionId === id)),
        sessions: () => Effect.succeed([]),
        latest: () => Effect.succeed(null),
        // Store-only load probe: this finite lease does not prove alarm durability.
        prearm: () => Effect.sync(() => Date.now() + 60_000),
        wake: () => Effect.void,
        deliver: (m) =>
          Effect.sync(() => {
            delivered.push(m.id)
          }),
      }
      let service = new AgentCoordination(store, host)
      const admission: number[] = []
      const started = performance.now()
      yield* Effect.forEach(
        Array.from({ length: 3200 }, (_, n) => n),
        (n) => {
          const sender = n % 100
          return Effect.suspend(() => {
            const before = performance.now()
            return service
              .send(sender, `load-${n}`, {
                to: agents[(sender + 1) % 100]!.address,
                text: payload,
              })
              .pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    admission.push(performance.now() - before)
                  })
                )
              )
          })
        },
        { concurrency: 16, discard: true }
      )
      const enqueueMs = performance.now() - started
      const expected = yield* db.use((orm) => orm.select().from(agentMessages))
      const drainStart = performance.now()
      let pumps = 0
      while ((yield* service.pump()) !== undefined) {
        assert(++pumps < 1000, "Queue did not settle")
      }
      const drainMs = performance.now() - drainStart
      assert.equal(delivered.length, 3200)
      assert.equal(new Set(delivered).size, 3200)
      for (const agent of agents) {
        const rows = expected
          .filter((r) => r.recipient_session === agent.address.sessionId)
          .sort((a, b) => a.sequence - b.sequence)
        assert.deepEqual(
          delivered.filter((id) => rows.some((r) => r.id === id)),
          rows.map((r) => r.id)
        )
      }
      const cap = yield* service
        .send(0, "over-session-cap", {
          to: agents[1]!.address,
          text: "Rejected",
        })
        .pipe(Effect.result)
      assert.equal(cap._tag, "Failure")
      console.log(
        JSON.stringify({
          case: "concurrent-admission-and-drain",
          sessions: 100,
          messages: 3200,
          concurrency: 16,
          payloadCharacters: payload.length,
          payloadBytes: new TextEncoder().encode(payload).byteLength,
          enqueueMs: round(enqueueMs),
          enqueuePerSecond: round(3200 / (enqueueMs / 1000)),
          admissionP50Ms: round(percentile(admission, 0.5)),
          admissionP95Ms: round(percentile(admission, 0.95)),
          drainMs: round(drainMs),
          pumps: pumps + 1,
          uniqueDelivered: delivered.length,
          ordered: true,
          sessionCapEnforced: true,
        })
      )

      let soakMessages = 0
      if (process.env.COORDINATION_SOAK === "1") {
        const soakStart = performance.now()
        while (performance.now() - soakStart < 60000) {
          if (soakMessages % 32 === 0) {
            for (let n = 0; n < 2; n++) {
              const id = agents.length
              agents.push({
                ...agents[0]!,
                nativeId: id,
                address: { sessionId: `soak-${id}`, agentId: "main" },
              })
            }
            service = new AgentCoordination(new CoordinationStore(db), host)
          }
          yield* service.send(agents.length - 2, `soak-${soakMessages}`, {
            to: agents.at(-1)!.address,
            text: payload,
          })
          yield* service.pump()
          soakMessages++
          yield* Effect.sleep("100 millis")
        }
        assert.equal(delivered.length, 3200 + soakMessages)
        assert.equal(new Set(delivered).size, delivered.length)
        assert.equal(yield* store.nextWake(), undefined)
        console.log(
          JSON.stringify({
            case: "paced-store-soak",
            elapsedMs: round(performance.now() - soakStart),
            messages: soakMessages,
            storeReopens: Math.ceil(soakMessages / 32),
            uniqueDelivered: true,
            queueEmpty: true,
          })
        )
      }

      // Fill the documented archive limit without timing fixture construction.
      const sample = Schema.decodeUnknownSync(Schema.fromJsonString(Message))(
        expected[0]!.payload
      )
      yield* db.transaction(() =>
        Effect.gen(function* () {
          for (let n = 3200 + soakMessages; n < 10000; n++) {
            const message = {
              ...sample,
              id: `history-${n}`,
              operationId: `history-op-${n}`,
              from: {
                sessionId: `history-from-${Math.floor(n / 32)}`,
                agentId: "main",
              },
              to: {
                sessionId: `history-to-${Math.floor(n / 32)}`,
                agentId: "main",
              },
            }
            yield* db.use((orm) =>
              orm.insert(agentMessages).values({
                id: message.id,
                operation_id: message.operationId,
                sender_session: message.from.sessionId,
                sender_agent: "main",
                recipient_session: message.to.sessionId,
                recipient_agent: "main",
                payload: JSON.stringify(message),
                state: "delivered",
                retry_at: 0,
              })
            )
          }
        })
      )
      // Use fresh session identities to distinguish archive capacity from session capacity.
      const fresh = agents.length
      agents.push(
        {
          ...agents[0]!,
          address: { sessionId: "fresh-a", agentId: "main" },
          nativeId: fresh,
        },
        {
          ...agents[0]!,
          address: { sessionId: "fresh-b", agentId: "main" },
          nativeId: fresh + 1,
        }
      )
      const fullAt = performance.now()
      const archive = yield* service
        .send(fresh, "full-archive-fresh", {
          to: agents[fresh + 1]!.address,
          text: "Rejected",
        })
        .pipe(Effect.result)
      assert.equal(archive._tag, "Failure")
      if (archive._tag === "Failure")
        assert.equal(archive.failure.code, "limit")
      const rejectionMs = round(performance.now() - fullAt)
      const pages = yield* db.use((orm) => orm.all(sql`PRAGMA page_count`))
      console.log(
        JSON.stringify({
          case: "full-archive",
          rows: 10000,
          archiveCapEnforced: true,
          rejectionMs,
          pageCount: pages,
          retention:
            "No automatic retention; new messages remain refused at this cap.",
        })
      )
    })
  )
)
