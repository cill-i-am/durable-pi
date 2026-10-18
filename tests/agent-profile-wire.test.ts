import { Schema } from "effect"
import { expect, it } from "vitest"

import { AgentList, AgentProfile } from "../src/agents/contracts"
import {
  AgentProfile as StoredProfile,
  originalAgent,
} from "../src/agents/domain"

it("accepts old actor profiles in web lists and individual responses during rollout", () => {
  const { slug: _, ...legacy } = originalAgent("original")
  expect(Schema.decodeUnknownSync(AgentList)({ agents: [legacy] })).toEqual({
    agents: [{ ...legacy, slug: "home" }],
  })
  expect(Schema.decodeUnknownSync(AgentProfile)(legacy).slug).toBe("home")
  expect(() => Schema.decodeUnknownSync(StoredProfile)(legacy)).toThrow()
})

it("preserves current slugs and rejects malformed current responses", () => {
  const profile = originalAgent("original")
  expect(Schema.decodeUnknownSync(AgentProfile)(profile)).toEqual(profile)
  expect(() =>
    Schema.decodeUnknownSync(AgentList)({
      agents: [{ ...profile, slug: "../other" }],
    })
  ).toThrow()
})
