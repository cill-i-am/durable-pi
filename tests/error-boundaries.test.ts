import { Cause, Context, Effect, Exit } from "effect"
import { expect, it } from "vitest"

import { SqliteAgentCatalog } from "../src/agents/adapters/sqlite"
import { AgentStorageError } from "../src/agents/domain"
import { makeAgentCatalog } from "../src/agents/service"
import { AppStore } from "../src/apps/adapters/sqlite"
import { AppStorageError } from "../src/apps/contracts"
import { makeApps } from "../src/apps/service"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { makeConversations } from "../src/conversations/service"
import { ConversationStorageError } from "../src/conversations/turns"
import { SqliteRoutinePersistence } from "../src/routines/adapters/sqlite"
import { RoutineStorageError } from "../src/routines/persistence"
import { makeRoutineApplication, Routines } from "../src/routines/service"
import { SkillStore } from "../src/skills/adapters/sqlite"
import { SkillStorageError } from "../src/skills/contracts"
import { makeSkills } from "../src/skills/service"
import { database } from "./database"

const compoundDefect = new Error("Programming failure")
const cases: readonly {
  name: string
  error: () => { readonly _tag: string }
  read: (
    cause: unknown,
    mode?: "failure" | "defect" | "compound"
  ) => Effect.Effect<unknown, unknown>
}[] = [
  {
    name: "Apps",
    error: () => new AppStorageError({ operation: "read", cause: "private" }),
    read: (cause: unknown, mode = "failure") => {
      const store = new AppStore(database(), () => Effect.sync(() => true))
      store.list = () =>
        mode === "defect"
          ? Effect.die(cause)
          : mode === "compound"
            ? Effect.failCause(
                Cause.combine(
                  Cause.fail(cause as AppStorageError),
                  Cause.die(compoundDefect)
                )
              )
            : Effect.fail(cause as AppStorageError)
      return makeApps(store).list()
    },
  },
  {
    name: "Skills",
    error: () => new SkillStorageError({ operation: "read", cause: "private" }),
    read: (cause: unknown, mode = "failure") => {
      const store = new SkillStore(database())
      store.list = () =>
        mode === "defect"
          ? Effect.die(cause)
          : mode === "compound"
            ? Effect.failCause(
                Cause.combine(
                  Cause.fail(cause as SkillStorageError),
                  Cause.die(compoundDefect)
                )
              )
            : Effect.fail(cause as SkillStorageError)
      return makeSkills(store).list()
    },
  },
  {
    name: "Agents",
    error: () => new AgentStorageError(),
    read: (cause: unknown, mode = "failure") => {
      const store = new SqliteAgentCatalog(database())
      store.list = () =>
        mode === "defect"
          ? Effect.die(cause)
          : mode === "compound"
            ? Effect.failCause(
                Cause.combine(
                  Cause.fail(cause as AgentStorageError),
                  Cause.die(compoundDefect)
                )
              )
            : Effect.fail(cause as AgentStorageError)
      return makeAgentCatalog(store).list()
    },
  },
  {
    name: "Routines",
    error: () =>
      new RoutineStorageError({ operation: "read", cause: "private" }),
    read: (cause: unknown, mode = "failure") => {
      const store = new SqliteRoutinePersistence(database())
      store.list = () =>
        mode === "defect"
          ? Effect.die(cause)
          : mode === "compound"
            ? Effect.failCause(
                Cause.combine(
                  Cause.fail(cause as RoutineStorageError),
                  Cause.die(compoundDefect)
                )
              )
            : Effect.fail(cause as RoutineStorageError)
      return Context.get(
        makeRoutineApplication(
          store,
          () => Effect.sync(() => true),
          () => 1000,
          () => crypto.randomUUID()
        ),
        Routines
      ).list()
    },
  },
  {
    name: "Conversations",
    error: () =>
      new ConversationStorageError({ operation: "read", cause: "private" }),
    read: (cause: unknown, mode = "failure") => {
      const store = new ConversationStore(database(), {
        model: "gpt-6-luna",
        thinking: "low",
      })
      store.recent = () =>
        mode === "defect"
          ? Effect.die(cause)
          : mode === "compound"
            ? Effect.failCause(
                Cause.combine(
                  Cause.fail(cause as ConversationStorageError),
                  Cause.die(compoundDefect)
                )
              )
            : Effect.fail(cause as ConversationStorageError)
      return makeConversations(store).recent()
    },
  },
]

for (const context of cases) {
  it(`${context.name} preserves its checked storage failure without a class prototype`, () => {
    const error = context.error()
    Object.setPrototypeOf(error, Error.prototype)
    const exit = Effect.runSyncExit(context.read(error))
    expect(Exit.isFailure(exit) && exit.cause.reasons).toMatchObject([
      { _tag: "Fail", error: { _tag: error._tag } },
    ])
  })
  it(`${context.name} preserves an unexpected programming failure as a defect`, () => {
    const defect = new Error("Programming failure")
    const exit = Effect.runSyncExit(context.read(defect, "defect"))
    expect(Exit.isFailure(exit) && exit.cause.reasons).toMatchObject([
      { _tag: "Die", defect },
    ])
    expect(
      Exit.isFailure(exit) &&
        exit.cause.reasons[0]?._tag === "Die" &&
        exit.cause.reasons[0].defect
    ).toBe(defect)
  })
  it(`${context.name} preserves compound checked and defect Causes`, () => {
    const error = context.error(),
      exit = Effect.runSyncExit(context.read(error, "compound"))
    expect(Exit.isFailure(exit) && exit.cause.reasons).toMatchObject([
      { _tag: "Fail", error },
      { _tag: "Die", defect: compoundDefect },
    ])
  })
}
