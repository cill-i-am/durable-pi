import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import { AgentId } from "../src/agents/domain"
import {
  LEASE_MS,
  MAX_ATTEMPTS,
  type Delivery,
  type Envelope,
} from "../src/communication/contracts"
import {
  acknowledge,
  advanceDelivery,
  claimDelivery,
  deliveryFailed,
  newDelivery,
  retryDelivery,
} from "../src/communication/outbox.machine"

const request: Envelope = {
  version: 1,
  id: "outbox-request",
  taskId: "outbox-request",
  owner: "owner",
  from: Schema.decodeUnknownSync(AgentId)("home"),
  to: Schema.decodeUnknownSync(AgentId)("00000000-0000-4000-8000-000000000001"),
  correlationId: "turn",
  causationId: "tool",
  createdAt: 0,
  deadline: 600_000,
  depth: 1,
  payload: { kind: "question", objective: "Compare", context: "Text only" },
}
const receipt = { id: request.id, taskId: request.taskId, acceptedAt: 100 }
const restore = (delivery: Delivery): Delivery =>
  JSON.parse(JSON.stringify(delivery))

describe("communication outbox state", () => {
  it("starts with a versioned pending delivery and preserves its identity through lease recovery", () => {
    const initial = newDelivery(request, 0)
    expect(initial).toEqual({
      schemaVersion: 1,
      workflowVersion: 1,
      envelope: request,
      status: "pending",
      attempts: 0,
      attemptLimit: MAX_ATTEMPTS,
      nextAt: 0,
      error: null,
      receipt: null,
    })
    const first = claimDelivery(restore(initial), 0)
    expect(first).toMatchObject({
      status: "delivering",
      attempts: 1,
      nextAt: LEASE_MS,
    })
    expect(claimDelivery(restore(first), LEASE_MS - 1)).toEqual(first)
    const recovered = claimDelivery(restore(first), LEASE_MS)
    expect(recovered).toMatchObject({
      envelope: request,
      status: "delivering",
      attempts: 2,
      nextAt: 2 * LEASE_MS,
    })
    expect(initial.attempts).toBe(0)
  })

  it("claims only due pending or delivering records, including a zero wake time", () => {
    const pending = newDelivery(request, 100)
    expect(claimDelivery(pending, 99)).toEqual(pending)
    expect(claimDelivery(pending, 100).attempts).toBe(1)
    expect(claimDelivery(newDelivery(request, 0), 0).attempts).toBe(1)
    for (const status of ["pending", "delivering"] as const) {
      const dormant = { ...pending, status, nextAt: null }
      expect(claimDelivery(dormant, request.deadline)).toEqual(dormant)
    }
    for (const status of ["accepted", "failed", "expired"] as const) {
      const closed = { ...pending, status, nextAt: 0 }
      expect(claimDelivery(restore(closed), 100)).toEqual(closed)
      expect(claimDelivery(restore(closed), request.deadline)).toEqual(closed)
    }
  })

  it("fences stale acknowledgements and failures before retaining a matching receipt", () => {
    const old = claimDelivery(newDelivery(request, 0), 0)
    const active = claimDelivery(restore(old), LEASE_MS)
    for (const attempt of [old.attempts, active.attempts + 1]) {
      expect(acknowledge(active, attempt, receipt)).toBeUndefined()
      expect(deliveryFailed(active, attempt, 100, 10, true)).toBeUndefined()
    }
    expect(() =>
      acknowledge(active, active.attempts, { ...receipt, id: "wrong" })
    ).toThrow("another message")
    expect(() =>
      acknowledge(active, active.attempts, { ...receipt, taskId: "wrong" })
    ).toThrow("another message")
    const accepted = acknowledge(restore(active), active.attempts, receipt)!
    expect(accepted).toMatchObject({
      status: "accepted",
      receipt,
      nextAt: null,
      error: null,
      attempts: 2,
    })
    expect(
      acknowledge(restore(accepted), active.attempts, receipt)
    ).toBeUndefined()
    expect(
      deliveryFailed(accepted, active.attempts, 100, 10, false)
    ).toBeUndefined()
    expect(retryDelivery(accepted, 100)).toBeUndefined()
  })

  it("bounds automatic retries at eight while preserving cumulative attempts on manual retry", () => {
    let delivery = newDelivery(request, 0)
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const now = attempt * 10
      delivery = claimDelivery(restore(delivery), now)
      expect(delivery.attempts).toBe(attempt)
      delivery = deliveryFailed(restore(delivery), attempt, now, 10, false)!
      expect(delivery.status).toBe(
        attempt === MAX_ATTEMPTS ? "failed" : "pending"
      )
      expect(delivery.nextAt).toBe(attempt === MAX_ATTEMPTS ? null : now + 10)
    }
    expect(claimDelivery(delivery, 100)).toEqual(delivery)
    const retried = retryDelivery(restore(delivery), 100)!
    expect(retried).toMatchObject({
      status: "pending",
      attempts: MAX_ATTEMPTS,
      attemptLimit: 2 * MAX_ATTEMPTS,
      nextAt: 100,
      error: null,
      envelope: request,
    })
    expect(claimDelivery(retried, 100).attempts).toBe(MAX_ATTEMPTS + 1)
    expect(
      acknowledge(claimDelivery(retried, 100), MAX_ATTEMPTS, receipt)
    ).toBeUndefined()
    expect(retryDelivery(retried, 100)).toBeUndefined()
    expect(retryDelivery(claimDelivery(retried, 100), 100)).toBeUndefined()
  })

  it("preserves deadline, budget and permanent rejection outcomes", () => {
    const pending = newDelivery(request, 0)
    expect(claimDelivery(pending, request.deadline)).toMatchObject({
      status: "expired",
      attempts: 0,
      nextAt: null,
      error: "Delivery deadline or attempt budget exhausted.",
    })
    expect(
      claimDelivery({ ...pending, attempts: MAX_ATTEMPTS }, 0)
    ).toMatchObject({
      status: "failed",
      nextAt: null,
    })
    const active = claimDelivery(pending, 0)
    const nearDeadline = deliveryFailed(
      active,
      1,
      request.deadline - 1,
      10,
      false
    )!
    expect(nearDeadline).toMatchObject({
      status: "pending",
      nextAt: request.deadline,
    })
    const expired = deliveryFailed(active, 1, request.deadline, 10, true)!
    expect(expired).toMatchObject({ status: "expired", nextAt: null })
    expect(() => retryDelivery(restore(expired), request.deadline)).toThrow(
      "cannot be retried"
    )
    const rejected = deliveryFailed(active, 1, 100, 10, true)!
    expect(rejected).toMatchObject({
      status: "failed",
      nextAt: null,
      error: "Delivery was rejected. Inspect this message before retrying.",
    })
    expect(retryDelivery(restore(rejected), 101)).toMatchObject({
      attempts: 1,
      attemptLimit: MAX_ATTEMPTS + 1,
    })
  })

  it("rejects malformed machine events and unsupported persisted versions before progression", () => {
    const pending = newDelivery(request, 0)
    const active = claimDelivery(pending, 0)
    for (const event of [
      { type: "CLAIM", now: "0" },
      { type: "CLAIM", now: -1 },
      { type: "ACK", attempt: "1", receipt },
      { type: "ACK", attempt: 1, receipt: { ...receipt, acceptedAt: -1 } },
      { type: "FAILED", attempt: 1, now: 100, delay: -1, permanent: false },
      { type: "FAILED", attempt: 1, now: 100, delay: 10, permanent: "yes" },
      { type: "RETRY", now: null },
    ]) {
      expect(() => advanceDelivery(active, event as never)).toThrow()
    }
    for (const saved of [
      { ...pending, schemaVersion: 2 },
      { ...pending, workflowVersion: 2 },
      { ...pending, status: "future" },
    ]) {
      expect(() => advanceDelivery(saved, { type: "CLAIM", now: 0 })).toThrow()
    }
    expect(active).toMatchObject({
      status: "delivering",
      attempts: 1,
      receipt: null,
    })
  })
})
