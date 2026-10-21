import { expect, it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import { vi } from "vitest"

import type { TimelineItem } from "../src/conversations/contracts"
import { conversationFixture } from "./conversation-fixture"
import { corrupt } from "./database"

const activity = (id: string): readonly TimelineItem[] => [
  { id, type: "text", text: `Saved ${id}` },
]

it.effect(
  "reads 100 saved activities in one transaction and query with parity and fresh rows",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      const ids = Array.from({ length: 100 }, (_, i) => `turn-${i}`)
      ids[99] = "turn-'quoted'"
      for (const id of [...ids, "outside"])
        f.db.run(
          "INSERT INTO chat_turns(id,text,status,created_at) VALUES (?,?,'done','2026-10-21')",
          id,
          id
        )
      for (const id of ids)
        yield* f.materialization.saveActivity(id, activity(id))
      yield* f.materialization.saveActivity("outside", activity("outside"))
      const expected = new Map(
        yield* Effect.forEach(ids, (id) =>
          f.journal
            .activity(id)
            .pipe(Effect.map((items) => [id, items!] as const))
        )
      )
      const read = vi.spyOn(f.db, "use")
      const transaction = vi.spyOn(f.db, "transaction")
      const saved = yield* f.journal.activities([...ids, ids[0]!, "missing"])
      expect(saved).toEqual(expected)
      expect(read).toHaveBeenCalledOnce()
      expect(transaction).toHaveBeenCalledOnce()
      expect(saved.has("outside")).toBe(false)
      expect(saved.has("missing")).toBe(false)
      yield* f.materialization.saveActivity(ids[0]!, [])
      expect((yield* f.journal.activities([ids[0]!])).get(ids[0]!)).toEqual([])
      read.mockClear()
      expect((yield* f.journal.activities([])).size).toBe(0)
      expect(read).not.toHaveBeenCalled()
    })
)

it.effect(
  "keeps bulk activity reads in the caller's transaction and does not cache rolled-back rows",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      yield* f.store.admit({ operationId: "turn", text: "question" })
      yield* f.materialization.saveActivity("turn", activity("before"))
      const failed = yield* f.db
        .transaction(() =>
          Effect.gen(function* () {
            yield* f.materialization.saveActivity("turn", activity("during"))
            expect((yield* f.journal.activities(["turn"])).get("turn")).toEqual(
              activity("during")
            )
            return yield* Effect.fail("rollback")
          })
        )
        .pipe(Effect.result)
      expect(failed).toMatchObject({ _tag: "Failure", failure: "rollback" })
      expect((yield* f.journal.activities(["turn"])).get("turn")).toEqual(
        activity("before")
      )
    })
)

it.effect(
  "ignores corrupt activity outside the visible keys and preserves defects for selected corruption",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationFixture()
      for (const id of ["visible", "corrupt"])
        f.db.run(
          "INSERT INTO chat_turns(id,text,status,created_at) VALUES (?,?,'done','2026-10-21')",
          id,
          id
        )
      corrupt(f.db, "INSERT INTO chat_activity VALUES ('corrupt','not JSON')")
      yield* f.materialization.saveActivity("visible", activity("visible"))
      expect((yield* f.journal.activities(["visible"])).get("visible")).toEqual(
        activity("visible")
      )
      const exit = yield* f.journal.activities(["corrupt"]).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
    })
)
