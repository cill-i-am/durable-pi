import { expect, it } from "@effect/vitest"
import { Cause, Clock, Effect, Exit } from "effect"
import { SqlError, UnknownError } from "effect/sql/SqlError"
import {
  ConversationJournal,
  makeConversationJournal,
} from "../src/conversations/journal"
import { sqliteConversationJournal } from "../src/conversations/adapters/sqlite-journal"
import type { ConversationObservation } from "../src/conversations/execution"
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
        f.store.admit({ operationId: "root", text: "hello" })
      ).turn
      const use = f.db.use
      let queries = 0
      f.db.use = (body) =>
        Effect.suspend(() => {
          queries++
          return use(body)
        })
      const layer = sqliteConversationJournal(f.db, f.store, f.memoryLedger)
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
        f.store.admit({ operationId: "root", text: "hello" })
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
        f.store.admit({
          operationId: "root",
          text: "new question",
        })
      ).turn
      const prompt = yield* f.journal.prompt(root.id, "be careful")
      const content = JSON.parse(prompt!)
      expect(content[0].text).toContain("earlier summary")
      expect(content[0].text).not.toContain("new question")
      expect(content[1].text).toContain("private note")
      expect(content[1].text).toContain(
        "New user message (archive ID 1):\nnew question"
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
      f.store.admit({ operationId: "root", text: "hello" })
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
      f.store.admit({ operationId: "root", text: "hello" })
    ).turn
    const journal = makeConversationJournal(
      f.store,
      {
        transactionGroup: {},
        append: (...args) => f.memoryLedger.append(...args),
        render: () => f.memoryLedger.render(),
        notes: () => f.memoryLedger.notes(),
      },
      f.materialization
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
      f.store.admit({ operationId: "root", text: "hello" })
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
      f.store.admit({ operationId: "root", text: "hello" })
    ).turn
    Effect.runSync(
      f.store.admit({ operationId: "steer", text: "use blue", mode: "steer" })
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
        f.store.admit({ operationId: "root", text: "hello" })
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
        f.store.admit({ operationId: "root", text: "hello" })
      ).turn
      const journal = makeConversationJournal(
        f.store,
        {
          transactionGroup: f.db,
          append: f.memoryLedger.append.bind(f.memoryLedger),
          notes: f.memoryLedger.notes.bind(f.memoryLedger),
          render: () => {
            throw new Error("programming defect")
          },
        },
        f.materialization
      )
      const exit = yield* journal.prompt(root.id, "").pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
      expect(yield* f.memory.total()).toBe(0)
    })
)
