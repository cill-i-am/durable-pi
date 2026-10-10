import { expect, it } from "vitest"
import { homeAgentId } from "./domain"
import { database } from "../../tests/database"
import { BotConfigurationStore } from "./adapters/configuration"

it("keeps archive admission closed across delayed routing, restart and out-of-order policy RPCs", () => {
  const db = database()
  const bot = new BotConfigurationStore(db)
  const active = {
    id: homeAgentId,
    name: "Test",
    instructions: "First policy",
    revision: 0,
    status: "active" as const,
    createdAt: "today",
    updatedAt: "today",
  }
  bot.configure("owner", active)
  bot.configure("owner", { ...active, revision: 1, status: "archived" })
  bot.configure("owner", active)
  expect(bot.read()?.status).toBe("archived")
  const restarted = new BotConfigurationStore(db)
  expect(restarted.read()?.status).toBe("archived")
  restarted.configure("owner", {
    ...active,
    revision: 2,
    instructions: "New policy",
  })
  restarted.configure("owner", { ...active, revision: 1, status: "archived" })
  expect(restarted.read()).toMatchObject({
    status: "active",
    revision: 2,
    instructions: "New policy",
  })
  expect(() =>
    restarted.configure("different-owner", { ...active, revision: 3 })
  ).toThrow("Owner mismatch")
})
