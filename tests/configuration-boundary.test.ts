import { expect, it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import {
  BotConfiguration,
  configurationApplication,
  configurationChange,
} from "../src/agents/configuration"
import { homeAgentId } from "../src/agents/domain"
import { BotConfigurationStore } from "../src/agents/adapters/configuration"
import { database, corrupt } from "./database"

const profile = {
  id: homeAgentId,
  name: "Test",
  instructions: "Policy",
  revision: 0,
  status: "active" as const,
  createdAt: "legacy date",
  updatedAt: "legacy date",
}
it.effect(
  "reads a legacy configuration and applies the first revision without changing owner identity",
  () =>
    Effect.gen(function* () {
      const db = database(),
        store = new BotConfigurationStore(db)
      db.run("INSERT INTO bot_configuration VALUES (1,'owner','Legacy')")
      const configuration = yield* BotConfiguration.pipe(
        Effect.provide(configurationApplication(store))
      )
      expect(yield* configuration.read()).toEqual({
        owner: "owner",
        instructions: "Legacy",
        revision: -1,
        status: "active",
      })
      yield* configuration.configure("owner", profile)
      expect(yield* configuration.read()).toMatchObject({
        owner: "owner",
        instructions: "Policy",
        revision: 0,
      })
      expect(
        yield* configuration
          .configure("another owner", { ...profile, revision: 1 })
          .pipe(Effect.result)
      ).toMatchObject({ _tag: "Failure", failure: { _tag: "AgentConflict" } })
    })
)
it("rejects older or replayed configuration updates across generated revision/status combinations", () => {
  for (let current = 0; current < 20; current++)
    for (let incoming = 0; incoming < 20; incoming++)
      for (const status of ["active", "archived"] as const) {
        const saved = {
          owner: "owner",
          instructions: "Saved",
          revision: current,
          status,
        }
        expect(
          configurationChange(saved, "owner", {
            ...profile,
            revision: incoming,
            status: status === "active" ? "archived" : "active",
          })
        ).toBe(incoming > current)
      }
})
it.effect(
  "rolls instructions and admission back together after an admission write failure",
  () =>
    Effect.gen(function* () {
      const db = database(),
        store = new BotConfigurationStore(db)
      const configuration = yield* BotConfiguration.pipe(
        Effect.provide(configurationApplication(store))
      )
      yield* configuration.configure("owner", profile)
      db.run(
        "CREATE TRIGGER reject_admission BEFORE UPDATE ON bot_admission BEGIN SELECT RAISE(ABORT,'admission failed'); END"
      )
      expect(
        yield* configuration
          .configure("owner", {
            ...profile,
            revision: 1,
            instructions: "Changed",
            status: "archived",
          })
          .pipe(Effect.result)
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "AgentStorageError" },
      })
      expect(yield* configuration.read()).toEqual({
        owner: "owner",
        instructions: "Policy",
        revision: 0,
        status: "active",
      })
    })
)
it.effect(
  "keeps malformed persisted admission as a defect and database read failure typed",
  () =>
    Effect.gen(function* () {
      const db = database(),
        store = new BotConfigurationStore(db)
      const configuration = yield* BotConfiguration.pipe(
        Effect.provide(configurationApplication(store))
      )
      yield* configuration.configure("owner", profile)
      corrupt(db, "UPDATE bot_admission SET status='invalid'")
      const exit = yield* configuration.read().pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
      db.run(
        "ALTER TABLE bot_configuration RENAME TO unavailable_configuration"
      )
      const result = yield* configuration.read().pipe(Effect.result)
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "AgentStorageError" },
      })
      expect(JSON.stringify(result)).not.toContain("no such table")
      expect(JSON.stringify(result)).not.toContain("bot_configuration")
    })
)
