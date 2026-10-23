import { expect, it } from "@effect/vitest"
import { Clock, Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"

import {
  makeConversationJournal,
  type ConversationJournalMaintenance,
} from "../src/conversations/journal"
import { conversationPump } from "../src/conversations/pump"
import { ConversationConflict } from "../src/conversations/turns"
import { conversationFixture } from "./conversation-fixture"

it.effect(
  "retains both Memory discovery receipts when completion commits and publication is lost",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      f.db.run(
        "CREATE TABLE journal_discovery(owner TEXT PRIMARY KEY, deadline INTEGER NOT NULL)"
      )
      const journal = makeConversationJournal(
        f.store,
        f.memoryLedger,
        f.materialization,
        {
          arm: () =>
            Effect.gen(function* () {
              const deadline = (yield* Clock.currentTimeMillis) + 60_000
              for (const owner of ["summary", "backup"])
                f.db.run(
                  "INSERT OR REPLACE INTO journal_discovery VALUES(?, ?)",
                  owner,
                  deadline
                )
              const lease = { deadline, current: () => true }
              return { summary: lease, backup: lease }
            }),
        }
      )
      yield* f.store.admit({ operationId: "root", text: "hello" })
      yield* f.store.requestStop("root")
      f.host.completed = () => Effect.die("lost postcommit publication")
      const pump = () =>
        conversationPump(
          f.conversations,
          f.memory,
          journal,
          f.execution,
          f.host
        )
      expect(Exit.isFailure(yield* pump().run().pipe(Effect.exit))).toBe(true)
      expect((yield* f.store.get("root"))?.status).toBe("cancelled")
      expect(yield* f.memory.total()).toBe(2)
      expect(f.events).not.toContain("compaction")
      expect(f.events).not.toContain("backup")
      // A fresh host has no active root and cannot recover the lost doorbell.
      expect(yield* pump().run()).toBeUndefined()
      expect(yield* f.store.active()).toBeUndefined()
      expect(
        f.db.all("SELECT owner FROM journal_discovery ORDER BY owner")
      ).toEqual([{ owner: "backup" }, { owner: "summary" }])
    })
)

const observation = {
  settled: true,
  answer: "answer",
  liveAnswer: "answer",
  activity: [],
  archivedActivity: [{ id: "activity", type: "text" as const, text: "answer" }],
  archives: [{ source: "answer", kind: "talk" as const, text: "answer" }],
  consumed: ["root"],
  outcomes: [{ id: "root", delivery: "answered" as const }],
}
const admissionFixture = Effect.gen(function* () {
  const f = yield* conversationFixture()
  const root = (yield* f.store.admit({ operationId: "root", text: "hello" }))
    .turn
  let arms = 0
  const maintenance: {
    -readonly [
      K in keyof ConversationJournalMaintenance
    ]: ConversationJournalMaintenance[K]
  } = {
    arm: () =>
      Effect.sync(() => {
        arms++
      }).pipe(Effect.andThen(f.maintenance.arm())),
  }
  const journal = makeConversationJournal(
    f.store,
    f.memoryLedger,
    f.materialization,
    maintenance
  )
  const mutate = {
    prompt: () => journal.prompt(root.id, "instructions").pipe(Effect.asVoid),
    archive: () => journal.archive(root.id, observation),
    complete: () =>
      journal
        .complete(
          root,
          [{ id: root.id, delivery: "unanswered" }],
          "",
          "interrupted"
        )
        .pipe(Effect.asVoid),
  }
  const unchanged = Effect.gen(function* () {
    expect(yield* f.memory.total()).toBe(0)
    expect((yield* f.store.get(root.id))?.prompt).toBeNull()
    expect((yield* f.store.get(root.id))?.status).toBe("queued")
    expect((yield* f.store.get(root.id))?.delivery).toBe("queued")
    expect(f.db.all("SELECT * FROM chat_activity")).toEqual([])
  })
  return {
    ...f,
    root,
    journal,
    maintenance,
    mutate,
    unchanged,
    arms: () => arms,
  }
})

for (const operation of ["prompt", "archive", "complete"] as const) {
  it.effect(
    `${operation} does not commit Memory when maintenance prearm fails`,
    () =>
      Effect.gen(function* () {
        const f = yield* admissionFixture
        const failure = new ConversationConflict({
          message: "Memory maintenance requires explicit recovery",
        })
        f.maintenance.arm = () => Effect.fail(failure)
        expect(yield* f.mutate[operation]().pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure,
        })
        yield* f.unchanged
      })
  )
  for (const owner of ["summary", "backup"] as const) {
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      it.effect(
        `${operation} rejects ${owner} nonfuture or nonfinite discovery ${invalid}`,
        () =>
          Effect.gen(function* () {
            const f = yield* admissionFixture
            // Keep the other owner valid so either individual lease is required.
            f.maintenance.arm = () =>
              Clock.currentTimeMillis.pipe(
                Effect.map((now) => ({
                  summary: { deadline: now + 60_000, current: () => true },
                  backup: { deadline: now + 60_000, current: () => true },
                  [owner]: { deadline: invalid, current: () => true },
                }))
              )
            expect(
              yield* f.mutate[operation]().pipe(Effect.result)
            ).toMatchObject({
              _tag: "Failure",
              failure: { _tag: "ConversationConflict" },
            })
            yield* f.unchanged
          })
      )
    }
    for (const invalidation of ["expired", "replaced"] as const) {
      it.effect(
        `${operation} rejects ${owner} discovery ${invalidation} while queued behind actual SQLite`,
        () =>
          Effect.gen(function* () {
            const f = yield* admissionFixture
            const arming = yield* Deferred.make<void>(),
              armed = yield* Deferred.make<void>(),
              held = yield* Deferred.make<void>(),
              release = yield* Deferred.make<void>(),
              queued = yield* Deferred.make<void>()
            let current = true
            f.maintenance.arm = () =>
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis
                yield* Deferred.succeed(arming, undefined)
                yield* Deferred.await(armed)
                return {
                  summary: { deadline: now + 60_000, current: () => true },
                  backup: { deadline: now + 60_000, current: () => true },
                  [owner]: { deadline: now + 1000, current: () => current },
                }
              })
            const pending = yield* f.mutate[operation]().pipe(Effect.forkChild)
            yield* Deferred.await(arming)
            const holder = yield* f.db
              .transaction(() =>
                Deferred.succeed(held, undefined).pipe(
                  Effect.andThen(Deferred.await(release))
                )
              )
              .pipe(Effect.forkChild)
            yield* Deferred.await(held)
            const atomic = f.materialization.atomic
            f.materialization.atomic = (body) =>
              Deferred.succeed(queued, undefined).pipe(
                Effect.andThen(atomic(body))
              )
            yield* Deferred.succeed(armed, undefined)
            yield* Deferred.await(queued)
            if (invalidation === "expired") yield* TestClock.adjust(1000)
            else current = false
            yield* Deferred.succeed(release, undefined)
            yield* Fiber.join(holder)
            expect(
              yield* Fiber.join(pending).pipe(Effect.result)
            ).toMatchObject({
              _tag: "Failure",
              failure: { _tag: "ConversationConflict" },
            })
            yield* f.unchanged
          })
      )
    }
  }
}

it.effect(
  "prompt replay and no-Memory archive/completion do not require maintenance recovery",
  () =>
    Effect.gen(function* () {
      const f = yield* admissionFixture
      const pinned = yield* f.journal.prompt("root", "instructions")
      expect(f.arms()).toBe(1)
      f.maintenance.arm = () => Effect.die("No new Memory work may be admitted")
      expect(yield* f.journal.prompt("root", "changed")).toBe(pinned)
      yield* f.journal.archive("root", { ...observation, archives: [] })
      expect(
        yield* f.journal.complete(f.root, observation.outcomes, "answer", null)
      ).toBe(true)
      expect(
        yield* f.journal.complete(f.root, observation.outcomes, "answer", null)
      ).toBe(false)
      expect(yield* f.memory.total()).toBe(1)
      expect((yield* f.store.get("root"))?.status).toBe("done")
    })
)

it.effect("a Stop arriving during prompt prearm fences the later commit", () =>
  Effect.gen(function* () {
    const f = yield* admissionFixture
    f.maintenance.arm = () =>
      f.store.requestStop("root").pipe(
        Effect.andThen(
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              const lease = { deadline: now + 60_000, current: () => true }
              return { summary: lease, backup: lease }
            })
          )
        )
      )
    expect(yield* f.journal.prompt("root", "instructions")).toBeUndefined()
    expect(yield* f.memory.total()).toBe(0)
    expect((yield* f.store.get("root"))?.status).toBe("stopping")
  })
)

it.effect(
  "replayed Pi archives still reach completion when maintenance requires recovery",
  () =>
    Effect.gen(function* () {
      const f = yield* admissionFixture
      yield* f.journal.archive("root", observation)
      const prior = yield* f.memory.watermark()
      f.maintenance.arm = () =>
        Effect.die("Maintenance requires explicit recovery")
      yield* f.journal.archive("root", observation)
      expect(
        yield* f.journal.complete(f.root, observation.outcomes, "answer", null)
      ).toBe(true)
      expect(yield* f.memory.watermark()).toEqual(prior)
      expect((yield* f.store.get("root"))?.status).toBe("done")
    })
)

it.effect(
  "existing sources still run append provenance validation and preserve immutable text",
  () =>
    Effect.gen(function* () {
      const f = yield* admissionFixture
      yield* f.journal.archive("root", observation)
      f.maintenance.arm = () => Effect.die("Replay cannot renew maintenance")
      const replay = {
        ...observation,
        archives: [
          { ...observation.archives[0]!, text: "changed replay text" },
        ],
      }
      yield* f.journal.archive("root", replay)
      expect((yield* f.memory.entry(0))?.text).toBe("answer")
      const conflict = {
        ...replay,
        archivedActivity: [
          { id: "changed", type: "text" as const, text: "changed" },
        ],
        archives: replay.archives.map((item) => ({
          ...item,
          provenance: {
            author: { kind: "human" as const, id: "different-author" },
            conversationId: "root",
            recipients: [],
          },
        })),
      }
      expect(
        yield* f.journal.archive("root", conflict).pipe(Effect.result)
      ).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "InvalidMemory",
          message: "The archived message has different authorship.",
        },
      })
      expect(yield* f.journal.activity("root")).toEqual(
        observation.archivedActivity
      )
      expect(yield* f.memory.total()).toBe(1)
    })
)

it.effect(
  "a replay source removed after preflight cannot admit new Memory without a retained lease",
  () =>
    Effect.gen(function* () {
      const f = yield* admissionFixture
      yield* f.memory.append("answer", "talk", "answer")
      expect(yield* f.memoryLedger.hasSources([])).toBe(true)
      expect(yield* f.memoryLedger.hasSources(["answer", "answer"])).toBe(true)
      expect(yield* f.memoryLedger.hasSources(["answer", "absent"])).toBe(false)
      f.maintenance.arm = () =>
        Effect.die("Preflight found only existing sources")
      const atomic = f.materialization.atomic
      let calls = 0
      f.materialization.atomic = (body) =>
        atomic(body).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (++calls === 1)
                f.db.run("DELETE FROM memory_log WHERE source='answer'")
            })
          )
        )
      expect(
        yield* f.journal.archive("root", observation).pipe(Effect.result)
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConversationConflict" },
      })
      expect(yield* f.memory.total()).toBe(0)
      expect(f.db.all("SELECT * FROM chat_activity")).toEqual([])
      expect((yield* f.store.get("root"))?.delivery).toBe("queued")
    })
)

it.effect(
  "Stop completes with previously archived unanswered sources while maintenance requires recovery",
  () =>
    Effect.gen(function* () {
      const f = yield* admissionFixture
      yield* f.memory.append("user:root", "user", "hello")
      yield* f.memory.append("unanswered:root", "note", "retained note")
      f.maintenance.arm = () =>
        Effect.die("Existing Memory does not require new discovery")
      yield* f.store.requestStop("root")
      const root = (yield* f.store.get("root"))!
      expect(
        yield* f.journal.complete(
          root,
          [{ id: "root", delivery: "unanswered" }],
          "",
          null
        )
      ).toBe(true)
      expect((yield* f.store.get("root"))?.status).toBe("cancelled")
      expect(yield* f.memory.total()).toBe(2)
      expect((yield* f.memory.entry(1))?.text).toBe("retained note")
    })
)
