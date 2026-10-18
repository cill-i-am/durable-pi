import { Effect } from "effect"
import { expect, it } from "vitest"

import { database } from "../../tests/database"
import { BotConfigurationStore } from "./adapters/configuration"
import { homeAgentId } from "./domain"

it("keeps archive admission closed across delayed routing, restart and out-of-order policy RPCs", () => {
  const db = database()
  const bot = new BotConfigurationStore(db)
  const active = {
    slug: "test",
    id: homeAgentId,
    name: "Test",
    instructions: "First policy",
    revision: 0,
    status: "active" as const,
    createdAt: "today",
    updatedAt: "today",
  }
  Effect.runSync(bot.configure("owner", active))
  Effect.runSync(
    bot.configure("owner", { ...active, revision: 1, status: "archived" })
  )
  Effect.runSync(bot.configure("owner", active))
  expect(Effect.runSync(bot.read())?.status).toBe("archived")
  const restarted = new BotConfigurationStore(db)
  expect(Effect.runSync(restarted.read())?.status).toBe("archived")
  Effect.runSync(
    restarted.configure("owner", {
      ...active,
      revision: 2,
      instructions: "New policy",
    })
  )
  Effect.runSync(
    restarted.configure("owner", { ...active, revision: 1, status: "archived" })
  )
  expect(Effect.runSync(restarted.read())).toMatchObject({
    status: "active",
    revision: 2,
    instructions: "New policy",
  })
  expect(() =>
    Effect.runSync(
      restarted.configure("different-owner", { ...active, revision: 3 })
    )
  ).toThrow("Owner mismatch")
})
