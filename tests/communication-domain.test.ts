import { Schema } from "effect"
import { expect, it } from "vitest"

import { AgentId } from "../src/agents/domain"
import { Outcome, type Envelope } from "../src/communication/contracts"
import * as Domain from "../src/communication/domain"

const request: Envelope = {
  version: 1,
  id: "request",
  taskId: "request",
  owner: "owner",
  from: Schema.decodeUnknownSync(AgentId)("home"),
  to: Schema.decodeUnknownSync(AgentId)("00000000-0000-4000-8000-000000000001"),
  correlationId: "turn",
  causationId: "tool",
  createdAt: 0,
  deadline: 1000,
  depth: 1,
  payload: { kind: "question", objective: "Compare", context: "Text only" },
}
it("never reopens terminal tasks through cancellation, duplicate results or execution completion", () => {
  for (const status of Outcome.fields.status.literals) {
    for (const revision of [0, 1, 10, 99]) {
      const base = Domain.newTask(request, "outgoing")
      const task = {
        ...base,
        status,
        revision,
        outcome: { status, text: "Stored result" },
      }
      const incoming = { ...task, direction: "incoming" as const }
      const result = Domain.taskResult(
        incoming,
        { status: "completed", text: "Late result" },
        500
      ).envelope
      expect(Domain.receiveResult(task, result)).toBeUndefined()
      expect(Domain.cancelTask(task, 500)).toBeUndefined()
      expect(() =>
        Domain.requireFinish(
          incoming,
          revision,
          { status: "completed", text: "New execution" },
          500,
          "stale-owner"
        )
      ).toThrow("no longer owns")
      expect(task.outcome.text).toBe("Stored result")
    }
  }
})
it("admits delivery only within its deadline and attempt budget and ignores stale outcomes", () => {
  for (const limit of [1, 2, 8, 16]) {
    for (let attempts = 0; attempts <= limit; attempts++) {
      for (const now of [999, 1000, 1001]) {
        const original = {
          ...Domain.newDelivery(request, 0),
          attempts,
          attemptLimit: limit,
        }
        const claimed = Domain.claimDelivery(original, now)
        expect(claimed.status === "delivering").toBe(
          now < request.deadline && attempts < limit
        )
        expect(original.attempts).toBe(attempts)
        if (claimed.status === "delivering") {
          const receipt = {
            id: request.id,
            taskId: request.taskId,
            acceptedAt: now,
          }
          for (const stale of [claimed.attempts - 1, claimed.attempts + 1]) {
            expect(Domain.acknowledge(claimed, stale, receipt)).toBeUndefined()
            expect(
              Domain.deliveryFailed(claimed, stale, now, 10, false)
            ).toBeUndefined()
          }
          expect(
            Domain.acknowledge(claimed, claimed.attempts, receipt)?.status
          ).toBe("accepted")
        } else expect(claimed.nextAt).toBeNull()
      }
    }
  }
})
