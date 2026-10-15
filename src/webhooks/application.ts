import { Schema } from "effect"
import type { RoutineAdmissionState } from "../routines/service"
import {
  type ConfigureWebhook,
  type WebhookInfo,
  WebhookInfo as InfoSchema,
  reject,
} from "./contracts"
import type { WebhookPersistence } from "./persistence"

export class WebhookTransactions {
  constructor(
    private readonly records: WebhookPersistence["Service"],
    private readonly routines: RoutineAdmissionState["Service"],
    private readonly active: () => boolean
  ) {
    if (records.transactionGroup !== routines.transactionGroup)
      throw new Error(
        "Webhook receipts and routine runs must share a storage transaction group."
      )
  }
  info(id: string): WebhookInfo {
    const row = this.records.key(id)
    return {
      routineId: id,
      enabled: !!row?.hash,
      revision: row?.revision ?? 0,
      accepted: this.records.eventCount(id),
    }
  }
  configure(input: Omit<ConfigureWebhook, "key"> & { hash: string | null }) {
    return this.records.atomic(() => {
      if (!this.active())
        reject("conflict", "Restore this bot before changing its webhook.")
      const routine = this.routines.get(input.routineId)
      if (!routine || routine.status === "archived")
        reject("conflict", "Restore this routine before changing its webhook.")
      const previous = this.records.operation(input.operationId)
      if (previous) {
        if (previous.input !== JSON.stringify(input))
          reject(
            "conflict",
            "This request was cancelled or belongs to another change."
          )
        return Schema.decodeUnknownSync(InfoSchema)(JSON.parse(previous.result))
      }
      if (this.records.operationCount() >= 2000)
        reject("conflict", "This bot reached its webhook change limit.")
      const current = this.records.key(input.routineId)
      if ((current?.revision ?? 0) !== input.expectedRevision)
        reject(
          "conflict",
          "The webhook changed. Resolve this request and reload before changing it."
        )
      this.records.putKey(input.routineId, {
        revision: input.expectedRevision + 1,
        hash: input.hash,
      })
      const pending = this.routines.inFlight()
      if (
        pending?.routineId === input.routineId &&
        pending.trigger === "webhook" &&
        pending.status === "pending"
      )
        this.routines.cancelPendingRun(pending.id)
      const info = this.info(input.routineId)
      this.records.putOperation(input.operationId, {
        input: JSON.stringify(input),
        result: JSON.stringify(info),
      })
      return info
    })
  }
  cancel(operationId: string) {
    return this.records.atomic(() => {
      if (!this.active()) reject("conflict", "Restore this bot first.")
      const previous = this.records.operation(operationId)
      if (previous) return { applied: previous.input !== "cancelled" }
      if (this.records.operationCount() >= 2000)
        reject("conflict", "This bot reached its webhook change limit.")
      this.records.putOperation(operationId, {
        input: "cancelled",
        result: "null",
      })
      return { applied: false }
    })
  }
  authorized(id: string, hash: string) {
    const key = this.records.key(id)
    const expected = key?.hash ?? "0".repeat(64)
    let diff = expected.length ^ hash.length
    for (let i = 0; i < 64; i++)
      diff |= expected.charCodeAt(i) ^ (hash.charCodeAt(i) || 0)
    return !!key?.hash && diff === 0 && this.active()
  }
  accept(
    id: string,
    keyHash: string,
    eventId: string,
    payload: string,
    payloadHash: string
  ) {
    return this.records.atomic(() => {
      if (!this.authorized(id, keyHash))
        reject("unauthorized", "Invalid webhook authorization.")
      const previous = this.records.event(id, eventId)
      if (previous) {
        if (previous.hash !== payloadHash)
          reject("conflict", "This event ID already belongs to different data.")
        return { runId: previous.run_id, duplicate: true }
      }
      if (this.routines.get(id)?.status !== "active")
        reject("conflict", "This routine is paused or unavailable.")
      if (this.routines.inFlight())
        reject(
          "busy",
          "This bot already has a routine waiting or running. Retry this event later."
        )
      if (this.records.eventCount() >= 2000)
        reject("conflict", "This bot reached its webhook event limit.")
      const run = this.routines.acceptWebhook(id, payload)
      this.records.putEvent(id, eventId, { hash: payloadHash, run_id: run.id })
      return { runId: run.id, duplicate: false }
    })
  }
}
