import { describe, expect, it } from "vitest"

import { REPLY_LEASE_MS, type ReplyProgress } from "../src/replies/contracts"
import {
  advanceReplyMessage,
  newReplyMessage,
} from "../src/replies/message.machine"

const progress = {
  version: 1 as const,
  generation: 1,
  parts: [
    { text: "first", files: [] },
    { text: "second", files: [] },
  ],
  receipts: [] as string[],
}
const claim = (
  attemptId = "attempt",
  from: "waiting" | "sending" = "waiting",
  delivery: ReplyProgress = progress
) => ({
  type: "CLAIM" as const,
  from,
  attemptId,
  now: 1000,
  deadline: 1000 + REPLY_LEASE_MS,
  reply: "Frozen",
  delivery,
  authorized: true,
  expired: false,
  error: "Authority ended",
})
const start = () =>
  advanceReplyMessage(newReplyMessage("Frozen", true), claim())
const recover = (now = 1000 + REPLY_LEASE_MS) => ({
  type: "RECOVER" as const,
  now,
  force: false,
  attemptId: null,
  error: "Delivery unconfirmed",
})

describe("durable reply ownership", () => {
  it("admits only a fresh claimant, then one additional part after its receipt", () => {
    const started = start()
    expect(started).toMatchObject({
      state: "sending",
      revision: 1,
      attemptId: "attempt",
      sendIndex: 0,
      sendDeadline: 61000,
    })
    expect(advanceReplyMessage(started, claim("competitor"))).toEqual(started)
    expect(advanceReplyMessage(started, claim("attempt", "sending"))).toEqual(
      started
    )
    const delivery = { ...progress, receipts: ["provider-1"] }
    const checkpoint = advanceReplyMessage(started, {
      type: "CHECKPOINT",
      attemptId: "attempt",
      delivery,
    })
    expect(
      advanceReplyMessage(checkpoint, claim("stale", "sending", delivery))
    ).toEqual(checkpoint)
    const next = advanceReplyMessage(
      checkpoint,
      claim("attempt", "sending", delivery)
    )
    expect(next).toMatchObject({ state: "sending", sendIndex: 1, revision: 3 })
    expect(
      advanceReplyMessage(next, claim("attempt", "sending", delivery))
    ).toEqual(next)
  })
  it("recovers missing checkpoints as uncertainty at the deadline without authorizing another send", () => {
    const started = start()
    expect(advanceReplyMessage(started, recover(60999))).toEqual(started)
    const uncertain = advanceReplyMessage(
      JSON.parse(JSON.stringify(started)),
      recover()
    )
    expect(uncertain).toMatchObject({
      state: "uncertain",
      providerId: null,
      delivery: progress,
    })
    expect(advanceReplyMessage(uncertain, claim())).toEqual(uncertain)
    expect(
      advanceReplyMessage(uncertain, {
        type: "RETRY",
        deadline: 1000 + REPLY_LEASE_MS,
        waiting: true,
        acknowledgeDuplicateRisk: false,
      })
    ).toEqual(uncertain)
    const retry = advanceReplyMessage(uncertain, {
      type: "RETRY",
      deadline: 1000 + REPLY_LEASE_MS,
      waiting: true,
      acknowledgeDuplicateRisk: true,
    })
    const fresh = advanceReplyMessage(retry, claim("explicit-retry"))
    expect(
      advanceReplyMessage(fresh, {
        type: "CHECKPOINT",
        attemptId: "attempt",
        delivery: { ...progress, receipts: ["late-provider"] },
      })
    ).toEqual(fresh)
    expect(
      advanceReplyMessage(fresh, {
        type: "FINISH",
        attemptId: "attempt",
        state: "failed",
        providerId: null,
        error: "late failure",
      })
    ).toEqual(fresh)
    expect(
      advanceReplyMessage(fresh, {
        ...recover(),
        attemptId: "attempt",
        force: true,
      })
    ).toEqual(fresh)
  })
  it("retains all confirmed parts through recovery and never sends a completed plan again", () => {
    let record = start()
    for (let count = 1; count <= progress.parts.length; count++) {
      const delivery = {
        ...progress,
        receipts: Array.from({ length: count }, (_, n) => `provider-${n + 1}`),
      }
      record = advanceReplyMessage(record, {
        type: "CHECKPOINT",
        attemptId: "attempt",
        delivery,
      })
      if (count < progress.parts.length)
        record = advanceReplyMessage(
          record,
          claim("attempt", "sending", delivery)
        )
    }
    const restored = advanceReplyMessage(JSON.parse(JSON.stringify(record)), {
      ...recover(0),
      force: true,
    })
    expect(restored).toMatchObject({
      state: "sent",
      providerId: "provider-2",
      delivery: { receipts: ["provider-1", "provider-2"] },
    })
    expect(advanceReplyMessage(restored, claim())).toEqual(restored)
    expect(
      advanceReplyMessage(restored, {
        type: "RETRY",
        deadline: 1000 + REPLY_LEASE_MS,
        waiting: true,
        acknowledgeDuplicateRisk: true,
      })
    ).toEqual(restored)
  })
  it("keeps the immutable plan and receipt prefix, including across explicit retry", () => {
    const started = start()
    for (const delivery of [
      { ...progress, receipts: ["one", "two"] },
      {
        ...progress,
        parts: [{ text: "changed", files: [] }],
        receipts: ["one"],
      },
      { ...progress, generation: 2, receipts: ["one"] },
    ])
      expect(() =>
        advanceReplyMessage(started, {
          type: "CHECKPOINT",
          attemptId: "attempt",
          delivery,
        })
      ).toThrow()
    const uncertain = advanceReplyMessage(started, recover())
    const waiting = advanceReplyMessage(uncertain, {
      type: "RETRY",
      deadline: 1000 + REPLY_LEASE_MS,
      waiting: true,
      acknowledgeDuplicateRisk: true,
    })
    expect(() =>
      advanceReplyMessage(
        waiting,
        claim("new", "waiting", {
          ...progress,
          parts: [{ text: "changed", files: [] }],
        })
      )
    ).toThrow()
  })
  it("cannot dispatch after its pre-armed recovery window or after current authority ends", () => {
    const waiting = newReplyMessage("Frozen", true)
    expect(advanceReplyMessage(waiting, { ...claim(), now: 61000 })).toEqual(
      waiting
    )
    expect(
      advanceReplyMessage(waiting, { ...claim(), authorized: false }).state
    ).toBe("cancelled")
    expect(
      advanceReplyMessage(waiting, { ...claim(), expired: true }).state
    ).toBe("expired")
    const started = start()
    const checkpoint = advanceReplyMessage(started, {
      type: "CHECKPOINT",
      attemptId: "attempt",
      delivery: { ...progress, receipts: ["one"] },
    })
    const cancelled = advanceReplyMessage(checkpoint, {
      ...claim("attempt", "sending", checkpoint.delivery!),
      authorized: false,
    })
    expect(cancelled).toMatchObject({
      state: "cancelled",
      delivery: { receipts: ["one"] },
    })
  })
  it("rejects unknown record versions, malformed events and incomplete successful completion", () => {
    for (const key of ["schemaVersion", "workflowVersion"])
      expect(() =>
        advanceReplyMessage({ ...start(), [key]: 2 }, recover())
      ).toThrow()
    expect(() =>
      advanceReplyMessage(start(), { ...recover(), force: "yes" } as never)
    ).toThrow()
    expect(() =>
      advanceReplyMessage(start(), {
        type: "FINISH",
        attemptId: "attempt",
        state: "sent",
        providerId: "invented",
        error: null,
      })
    ).toThrow()
    expect(() =>
      advanceReplyMessage(
        { ...start(), delivery: { ...progress, receipts: ["1", "2", "3"] } },
        recover()
      )
    ).toThrow()
  })
})
