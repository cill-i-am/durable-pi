import { expect, it } from "vitest"
import { homeAgentId } from "../../agents/contracts"
import { catalogReducer, initialCatalog } from "./catalog-state"

it("retains the latest catalog when older loads succeed or fail out of order", () => {
  const profile = {
    id: homeAgentId,
    name: "Renamed assistant",
    instructions: "",
    status: "active" as const,
    revision: 1,
    createdAt: "today",
    updatedAt: "today",
  }
  let state = catalogReducer(initialCatalog, { type: "start", request: 1 })
  state = catalogReducer(state, { type: "start", request: 2 })
  state = catalogReducer(state, {
    type: "loaded",
    request: 2,
    agents: [profile],
  })
  expect(
    catalogReducer(state, { type: "loaded", request: 1, agents: [] })
  ).toBe(state)
  expect(catalogReducer(state, { type: "failed", request: 1 })).toBe(state)
  expect(state.agents[0]?.name).toBe("Renamed assistant")
  expect(state.loading).toBe(false)
  expect(state.error).toBe("")
})
