import { expect, it } from "vitest"
import { Context, Effect, Exit } from "effect"
import { AppStore } from "../src/apps/adapters/sqlite"
import { AppStorageError } from "../src/apps/contracts"
import { makeApps } from "../src/apps/service"
import { SkillStore } from "../src/skills/adapters/sqlite"
import { SkillStorageError } from "../src/skills/contracts"
import { makeSkills } from "../src/skills/service"
import { SqliteAgentCatalog } from "../src/agents/adapters/sqlite"
import { AgentStorageError } from "../src/agents/domain"
import { makeAgentCatalog } from "../src/agents/service"
import { SqliteRoutinePersistence } from "../src/routines/adapters/sqlite"
import { RoutineStorageError } from "../src/routines/persistence"
import { makeRoutineApplication, Routines } from "../src/routines/service"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { ConversationStorageError } from "../src/conversations/turns"
import { makeConversations } from "../src/conversations/service"
import { database } from "./database"

const cases: readonly {
  name: string
  error: () => { readonly _tag: string }
  read: (cause: unknown) => Effect.Effect<unknown, unknown>
}[] = [
  {
    name: "Apps",
    error: () => new AppStorageError({ operation: "read", cause: "private" }),
    read: (cause: unknown) => {
      const store = new AppStore(database(), () => true)
      store.list = () => {
        throw cause
      }
      return makeApps(store).list()
    },
  },
  {
    name: "Skills",
    error: () => new SkillStorageError({ operation: "read", cause: "private" }),
    read: (cause: unknown) => {
      const store = new SkillStore(database())
      store.list = () => {
        throw cause
      }
      return makeSkills(store).list()
    },
  },
  {
    name: "Agents",
    error: () => new AgentStorageError(),
    read: (cause: unknown) => {
      const store = new SqliteAgentCatalog(database())
      store.list = () => {
        throw cause
      }
      return makeAgentCatalog(store).list()
    },
  },
  {
    name: "Routines",
    error: () =>
      new RoutineStorageError({ operation: "read", cause: "private" }),
    read: (cause: unknown) => {
      const store = new SqliteRoutinePersistence(database())
      store.list = () => {
        throw cause
      }
      return Context.get(
        makeRoutineApplication(
          store,
          () => true,
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
    read: (cause: unknown) => {
      const store = new ConversationStore(database(), {
        model: "gpt-6-luna",
        thinking: "low",
      })
      store.recent = () => {
        throw cause
      }
      return makeConversations(store).recent()
    },
  },
]

for (const context of cases) {
  it(`${context.name} decodes its expected storage failure without a class prototype`, () => {
    const error = context.error()
    Object.setPrototypeOf(error, Error.prototype)
    const exit = Effect.runSyncExit(context.read(error))
    expect(Exit.isFailure(exit) && exit.cause.reasons).toMatchObject([
      { _tag: "Fail", error: { _tag: error._tag } },
    ])
  })
  it(`${context.name} preserves an unexpected programming failure as a defect`, () => {
    const defect = new Error("Programming failure")
    const exit = Effect.runSyncExit(context.read(defect))
    expect(Exit.isFailure(exit) && exit.cause.reasons).toMatchObject([
      { _tag: "Die", defect },
    ])
    expect(
      Exit.isFailure(exit) &&
        exit.cause.reasons[0]?._tag === "Die" &&
        exit.cause.reasons[0].defect
    ).toBe(defect)
  })
  it(`${context.name} rejects an invalid error contract even with the original class prototype`, () => {
    const defect = context.error()
    Object.defineProperty(defect, "_tag", { value: "UndocumentedFailure" })
    const exit = Effect.runSyncExit(context.read(defect))
    expect(
      Exit.isFailure(exit) &&
        exit.cause.reasons[0]?._tag === "Die" &&
        exit.cause.reasons[0].defect
    ).toBe(defect)
  })
}
