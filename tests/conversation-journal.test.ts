import { expect, it } from "@effect/vitest"
import { Cause, Clock, Effect, Exit } from "effect"
import { SqlError, UnknownError } from "effect/sql/SqlError"

import { sqliteConversationJournal } from "../src/conversations/adapters/sqlite-journal"
import type { ConversationObservation } from "../src/conversations/execution"
import {
  ConversationJournal,
  makeConversationJournal,
} from "../src/conversations/journal"
import { conversationFixture } from "./conversation-fixture"
import { database } from "./database"

const empty: ConversationObservation = {
  settled: false,
  answer: "",
  liveAnswer: "",
  activity: [],
  archivedActivity: [],
  archives: [],
  consumed: [],
  outcomes: [],
}
it.effect(
  "builds over migrated storage without implicit schema writes, preserving the transaction identity",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      const root = Effect.runSync(
        f.store.admit(
          { operationId: "root", text: "hello" },
          undefined,
          undefined,
          undefined,
          { discoveryDeadline: Date.now() + 60_000 }
        )
      ).turn
      const use = f.db.use
      let queries = 0
      f.db.use = (body) =>
        Effect.suspend(() => {
          queries++
          return use(body)
        })
      const layer = sqliteConversationJournal(
        f.db,
        f.store,
        f.memoryLedger,
        f.maintenance
      )
      expect(queries).toBe(0)
      const journal = yield* ConversationJournal.pipe(Effect.provide(layer))
      expect(queries).toBe(0)
      const prompt = yield* journal.prompt(root.id, "be careful")
      expect(queries).toBeGreaterThan(0)
      expect(Effect.runSync(f.store.get(root.id))?.prompt).toBe(prompt)
    })
)
it.effect(
  "rolls prompt and Memory writes back on an outer transaction commit failure",
  () =>
    Effect.gen(function* () {
      const native = database()
      let fail = false,
        depth = 0
      const db = {
        ...native,
        transaction: <T, TError, TRequirements>(
          body: () => Effect.Effect<T, TError, TRequirements>
        ) =>
          native.transaction(() =>
            Effect.gen(function* () {
              depth++
              try {
                const value = yield* body()
                if (fail && depth === 1)
                  return yield* Effect.fail(
                    new SqlError({
                      reason: new UnknownError({
                        cause: new Error("commit failed"),
                      }),
                    })
                  )
                return value
              } finally {
                depth--
              }
            })
          ),
      }
      const f = yield* conversationFixture(db)
      const root = Effect.runSync(
        f.store.admit(
          { operationId: "root", text: "hello" },
          undefined,
          undefined,
          undefined,
          { discoveryDeadline: Date.now() + 60_000 }
        )
      ).turn
      fail = true
      expect(
        yield* f.journal.prompt(root.id, "").pipe(Effect.result)
      ).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "ConversationStorageError",
          operation: "materialization transaction",
        },
      })
      fail = false
      expect(yield* f.memory.total()).toBe(0)
      expect(Effect.runSync(f.store.get(root.id))?.prompt).toBeNull()
    })
)
it.effect(
  "pins the old Memory view and new input atomically, preserving the prompt on replay",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      const earlier = yield* f.memory.append(
        "earlier",
        "user",
        "earlier message"
      )
      yield* f.memory.saveNode(
        { start: earlier.id, count: 1 },
        "earlier summary"
      )
      yield* f.memory.writeNote("MEMORY.md", "private note", earlier.id)
      const root = Effect.runSync(
        f.store.admit(
          {
            operationId: "root",
            text: "new question",
          },
          undefined,
          undefined,
          undefined,
          { discoveryDeadline: Date.now() + 60_000 }
        )
      ).turn
      const prompt = yield* f.journal.prompt(root.id, "be careful")
      const content = JSON.parse(prompt!)
      expect(content[0].text).toContain("earlier summary")
      expect(content[0].text).not.toContain("new question")
      expect(content[1].text).toContain("private note")
      expect(content[1].text).toContain(
        'Incoming message (archive ID 1):\n{"provenance":{"author":{"kind":"unknown"}},"content":"new question"}'
      )
      expect(yield* f.memory.total()).toBe(2)
      expect(yield* f.journal.prompt(root.id, "changed instructions")).toBe(
        prompt
      )
      expect(yield* f.memory.total()).toBe(2)
      expect(Effect.runSync(f.store.get(root.id))?.prompt).toBe(prompt)
    })
)
it.effect("rolls Memory append back when prompt pinning fails", () =>
  Effect.gen(function* () {
    const f = yield* conversationFixture()
    const root = Effect.runSync(
      f.store.admit(
        { operationId: "root", text: "hello" },
        undefined,
        undefined,
        undefined,
        { discoveryDeadline: Date.now() + 60_000 }
      )
    ).turn
    f.db.run(
      "CREATE TRIGGER reject_prompt BEFORE UPDATE OF prompt ON chat_turns WHEN NEW.prompt IS NOT NULL BEGIN SELECT RAISE(ABORT,'pin failed'); END"
    )
    expect(
      yield* f.journal.prompt(root.id, "").pipe(Effect.result)
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ConversationStorageError" },
    })
    expect(yield* f.memory.total()).toBe(0)
    expect(Effect.runSync(f.store.get(root.id))?.prompt).toBeNull()
  })
)
it.effect("rejects a separate Memory transaction group before writes", () =>
  Effect.gen(function* () {
    const f = yield* conversationFixture()
    const root = Effect.runSync(
      f.store.admit(
        { operationId: "root", text: "hello" },
        undefined,
        undefined,
        undefined,
        { discoveryDeadline: Date.now() + 60_000 }
      )
    ).turn
    const journal = makeConversationJournal(
      f.store,
      {
        transactionGroup: {},
        hasSources: (sources) => f.memoryLedger.hasSources(sources),
        append: (...args) => f.memoryLedger.append(...args),
        render: () => f.memoryLedger.render(),
        notes: () => f.memoryLedger.notes(),
      },
      f.materialization,
      f.maintenance
    )
    expect(
      yield* journal.prompt(root.id, "").pipe(Effect.result)
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ConversationConflict" },
    })
    expect(yield* f.memory.total()).toBe(0)
  })
)
it.effect("rolls activity, archives and consumed inputs back together", () =>
  Effect.gen(function* () {
    const f = yield* conversationFixture()
    const root = Effect.runSync(
      f.store.admit(
        { operationId: "root", text: "hello" },
        undefined,
        undefined,
        undefined,
        { discoveryDeadline: Date.now() + 60_000 }
      )
    ).turn
    const observation = {
      ...empty,
      archives: [{ source: "user:root", kind: "user" as const, text: "hello" }],
      consumed: [root.id],
      archivedActivity: [{ id: "a", type: "text" as const, text: "hello" }],
    }
    f.db.run(
      "CREATE TRIGGER reject_consumed BEFORE UPDATE OF delivery ON chat_turns WHEN NEW.delivery='consumed' BEGIN SELECT RAISE(ABORT,'consumed failed'); END"
    )
    expect(
      yield* f.journal.archive(root.id, observation).pipe(Effect.result)
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ConversationStorageError" },
    })
    expect(yield* f.memory.total()).toBe(0)
    expect(f.db.all("SELECT * FROM chat_activity")).toEqual([])
    expect(Effect.runSync(f.store.get(root.id))?.delivery).toBe("queued")
  })
)
it.effect("rejects stale completion before writing unanswered notes", () =>
  Effect.gen(function* () {
    const f = yield* conversationFixture()
    const root = Effect.runSync(
      f.store.admit(
        { operationId: "root", text: "hello" },
        undefined,
        undefined,
        undefined,
        { discoveryDeadline: Date.now() + 60_000 }
      )
    ).turn
    Effect.runSync(
      f.store.admit(
        { operationId: "steer", text: "use blue", mode: "steer" },
        undefined,
        undefined,
        undefined,
        { discoveryDeadline: Date.now() + 60_000 }
      )
    )
    expect(
      yield* f.journal.complete(
        root,
        [{ id: root.id, delivery: "unanswered" }],
        "",
        "interrupted"
      )
    ).toBe(false)
    expect(yield* f.memory.total()).toBe(0)
    expect(Effect.runSync(f.store.get(root.id))?.status).toBe("queued")
  })
)
it.effect(
  "rolls unanswered notes back if completion fails and uses Clock for retained notes",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      const root = Effect.runSync(
        f.store.admit(
          { operationId: "root", text: "hello" },
          undefined,
          undefined,
          undefined,
          { discoveryDeadline: Date.now() + 60_000 }
        )
      ).turn
      const outcomes = [{ id: root.id, delivery: "unanswered" as const }]
      f.db.run(
        "CREATE TRIGGER reject_finish BEFORE UPDATE OF status ON chat_turns WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT,'finish failed'); END"
      )
      expect(
        yield* f.journal
          .complete(root, outcomes, "", "interrupted")
          .pipe(Effect.result)
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConversationStorageError" },
      })
      expect(yield* f.memory.total()).toBe(0)
      expect(Effect.runSync(f.store.get(root.id))?.status).toBe("queued")
      f.db.run("DROP TRIGGER reject_finish")
      const now = yield* Clock.currentTimeMillis
      expect(yield* f.journal.complete(root, outcomes, "", "interrupted")).toBe(
        true
      )
      const note = (yield* f.memory.search("interrupted"))[0]!
      expect(note.source).toBe("unanswered:root")
      expect(note.date).toBe(new Date(now).toISOString())
      expect(yield* f.journal.complete(root, outcomes, "", "interrupted")).toBe(
        false
      )
      expect(yield* f.memory.total()).toBe(2)
    })
)
it.effect(
  "preserves programming defects from synchronous journal callbacks",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      const root = Effect.runSync(
        f.store.admit(
          { operationId: "root", text: "hello" },
          undefined,
          undefined,
          undefined,
          { discoveryDeadline: Date.now() + 60_000 }
        )
      ).turn
      const journal = makeConversationJournal(
        f.store,
        {
          transactionGroup: f.db,
          hasSources: (sources) => f.memoryLedger.hasSources(sources),
          append: f.memoryLedger.append.bind(f.memoryLedger),
          notes: f.memoryLedger.notes.bind(f.memoryLedger),
          render: () => {
            throw new Error("programming defect")
          },
        },
        f.materialization,
        f.maintenance
      )
      const exit = yield* journal.prompt(root.id, "").pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
      expect(yield* f.memory.total()).toBe(0)
    })
)

it.effect(
  "fences prompt, archive and completion writes by the same native owner",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      yield* f.store.admit(
        { operationId: "owned-root", text: "question" },
        undefined,
        undefined,
        undefined,
        { discoveryDeadline: Date.now() + 60_000 }
      )
      const root = (yield* f.store.claimControl(
        "owned-root",
        "native-owner",
        Date.now() + 60_000
      ))!
      expect(
        yield* f.journal.prompt(root.id, "instructions", "stale-owner")
      ).toBeUndefined()
      expect(yield* f.memory.total()).toBe(0)
      expect(
        yield* f.journal.prompt(root.id, "instructions", "native-owner")
      ).toBeDefined()
      const count = yield* f.memory.total()
      const observed = {
        ...empty,
        archives: [
          {
            source: "native-answer",
            kind: "talk" as const,
            text: "answer",
          },
        ],
        consumed: [root.id],
      }
      yield* f.journal.archive(root.id, observed, "stale-owner")
      expect(yield* f.memory.total()).toBe(count)
      expect((yield* f.store.get(root.id))?.delivery).toBe("queued")
      expect(
        yield* f.journal.complete(
          root,
          [{ id: root.id, delivery: "unanswered" }],
          "",
          null,
          "stale-owner"
        )
      ).toBe(false)
      expect(yield* f.memory.total()).toBe(count)
      yield* f.journal.archive(root.id, observed, "native-owner")
      expect((yield* f.store.get(root.id))?.delivery).toBe("consumed")
      expect(yield* f.memory.total()).toBe(count + 1)
      expect(
        yield* f.journal.complete(
          root,
          [{ id: root.id, delivery: "answered" }],
          "answer",
          null,
          "native-owner"
        )
      ).toBe(true)
      expect((yield* f.store.get(root.id))?.control?.owner).toBe("native-owner")
      yield* f.store.releaseControl(root.id, "native-owner", true)
      expect((yield* f.store.get(root.id))?.control?.owner).toBeNull()
    })
)

it.effect(
  "rejects duplicate completion members before appending unanswered Memory notes",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      for (const operationId of ["root", "child"])
        yield* f.store.admit(
          {
            operationId,
            text: operationId,
            mode: operationId === "root" ? "followUp" : "steer",
          },
          undefined,
          undefined,
          undefined,
          { discoveryDeadline: Date.now() + 60_000 }
        )
      const root = (yield* f.store.get("root"))!
      expect(
        yield* f.journal.complete(
          root,
          [
            { id: "root", delivery: "unanswered" },
            { id: "root", delivery: "unanswered" },
          ],
          "",
          null
        )
      ).toBe(false)
      expect(yield* f.memory.total()).toBe(0)
      expect((yield* f.store.get("child"))?.status).toBe("queued")
    })
)

it.effect(
  "does not archive an unpinned child prompt after its root stops",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      for (const id of ["root", "child"])
        yield* f.store.admit(
          {
            operationId: id,
            text: id,
            mode: id === "root" ? "followUp" : "steer",
          },
          undefined,
          undefined,
          undefined,
          { discoveryDeadline: Date.now() + 60_000 }
        )
      yield* f.store.requestStop("root", {
        discoveryDeadline: Date.now() + 60_000,
      })
      expect(yield* f.journal.prompt("child", "instructions")).toBeUndefined()
      expect(yield* f.memory.total()).toBe(0)
      expect((yield* f.store.get("child"))?.prompt).toBeNull()
    })
)
