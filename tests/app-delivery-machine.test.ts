import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { AppStore } from "../src/apps/adapters/sqlite"
import type { AppEvent } from "../src/apps/contracts"
import {
  advanceAppDelivery,
  restoreAppDelivery,
} from "../src/apps/delivery.machine"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { database } from "./database"

const event = () => ({
  id: crypto.randomUUID(),
  appId: crypto.randomUUID(),
  turnId: crypto.randomUUID(),
  version: 1,
  text: "Immutable interaction",
  createdAt: new Date().toISOString(),
  delivery: "pending" as const,
})
function fixture() {
  const db = database()
  let active = true
  const store = new AppStore(db, () => Effect.sync(() => active))
  const draft = Effect.runSync(
    store.save({
      id: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      expectedRevision: 0,
      definition: {
        title: "Tasks",
        description: "",
        blocks: [
          {
            id: "tasks",
            type: "checklist",
            title: "Tasks",
            items: [{ id: "one", label: "One" }],
          },
        ],
      },
    })
  )
  const published = Effect.runSync(
    store.publish({
      id: draft.id,
      operationId: crypto.randomUUID(),
      expectedRevision: draft.revision,
      version: 1,
    })
  )
  const input = {
    id: draft.id,
    operationId: crypto.randomUUID(),
    expectedRevision: published.revision,
    version: 1,
    action: {
      type: "check" as const,
      blockId: "tasks",
      itemId: "one",
      checked: true,
    },
  }
  const applied = Effect.runSync(store.interact(input))
  const conversations = new ConversationStore(db, {
    model: "test",
    thinking: "off",
  })
  const admission = {
    transactionGroup: db,
    admit: (record: AppEvent, discoveryDeadline: number) =>
      conversations
        .admit(
          { operationId: record.turnId, text: record.text },
          undefined,
          [],
          undefined,
          { discoveryDeadline }
        )
        .pipe(Effect.map(({ turn }) => turn.id)),
  }
  return {
    db,
    store,
    input,
    applied,
    admission,
    conversations,
    archiveBot: () => {
      active = false
    },
  }
}
describe("App delivery authority", () => {
  it("restores legacy pending/admitted identities and rejects future versions or corrupt projections", () => {
    const legacy = event()
    const restored = restoreAppDelivery(legacy)
    expect(restored).toMatchObject({
      ...legacy,
      lifecycle: { state: "pending", revision: 0 },
    })
    expect(
      restoreAppDelivery({ ...legacy, delivery: "queued" }).lifecycle.state
    ).toBe("admitted")
    expect(restoreAppDelivery(JSON.parse(JSON.stringify(restored)))).toEqual(
      restored
    )
    expect(() =>
      restoreAppDelivery({
        ...restored,
        lifecycle: { ...restored.lifecycle, workflowVersion: 2 },
      })
    ).toThrow()
    expect(() =>
      restoreAppDelivery({ ...restored, delivery: "queued" })
    ).toThrow()
  })
  it("rejects stale revisions and terminal resurrection and exhausts exactly five business retries", () => {
    let record = restoreAppDelivery(event())
    expect(advanceAppDelivery(record, { type: "ADMIT", revision: 99 })).toEqual(
      record
    )
    for (let i = 0; i < 5; i++) {
      const now = record.lifecycle.nextAt
      record = advanceAppDelivery(record, {
        type: "DEFER",
        revision: record.lifecycle.revision,
        now,
        reason: "capacity",
      })
      expect(record.lifecycle.attempts).toBe(i + 1)
      if (i < 4)
        expect(
          advanceAppDelivery(record, {
            type: "DEFER",
            revision: record.lifecycle.revision,
            now,
            reason: "capacity",
          })
        ).toEqual(record)
    }
    expect(record.delivery).toBe("exhausted")
    expect(record.deliveryMessage).toContain("send a new app interaction")
    expect(
      advanceAppDelivery(record, {
        type: "ADMIT",
        revision: record.lifecycle.revision,
      })
    ).toEqual(record)
  })
  it.each(["app archive", "version change", "bot archive"])(
    "cancels before Conversations admission after %s and preserves receipt",
    (mode) => {
      const f = fixture()
      if (mode === "bot archive") f.archiveBot()
      if (mode === "app archive")
        Effect.runSync(
          f.store.archive({
            id: f.applied.id,
            operationId: crypto.randomUUID(),
            expectedRevision: f.applied.revision,
            archived: true,
          })
        )
      if (mode === "version change") {
        const draft = Effect.runSync(
          f.store.save({
            id: f.applied.id,
            operationId: crypto.randomUUID(),
            expectedRevision: f.applied.revision,
            definition: f.applied.definition,
          })
        )
        Effect.runSync(
          f.store.publish({
            id: draft.id,
            operationId: crypto.randomUUID(),
            expectedRevision: draft.revision,
            version: 2,
          })
        )
      }
      expect(
        Effect.runSync(f.store.deliverNext(f.admission, Date.now() + 60_000))
      ).toBe(false)
      expect(Effect.runSync(f.conversations.recent())).toHaveLength(0)
      expect(
        Effect.runSync(f.store.detail(f.applied.id)).events[0]?.delivery
      ).toBe("cancelled")
      expect(
        f.db.all<{ result: string }>(
          "SELECT result FROM generated_app_operations WHERE id=?",
          f.input.operationId
        )[0]?.result
      ).toBe(JSON.stringify(f.applied))
    }
  )
  it("survives cold store reconstruction with one atomic admission and no duplicate native intent", () => {
    const f = fixture()
    const reconstructed = new AppStore(f.db, () => Effect.succeed(true))
    expect(
      Effect.runSync(
        reconstructed.deliverNext(f.admission, Date.now() + 60_000)
      )
    ).toBe(true)
    expect(
      Effect.runSync(
        reconstructed.deliverNext(f.admission, Date.now() + 60_000)
      )
    ).toBe(false)
    expect(Effect.runSync(f.conversations.recent())).toHaveLength(1)
    expect(
      Effect.runSync(reconstructed.interact(f.input, undefined, 0))
    ).toEqual(f.applied)
  })
  it("materializes expired orphan controls on status read without changing saved data", () => {
    const f = fixture()
    const raw = f.db.all<{ record: string }>(
      "SELECT record FROM generated_app_events"
    )[0]!
    const saved = JSON.parse(raw.record)
    saved.lifecycle.deadline = 0
    f.db.run("UPDATE generated_app_events SET record=?", JSON.stringify(saved))
    const detail = Effect.runSync(f.store.detail(f.applied.id))
    expect(detail.events[0]?.delivery).toBe("exhausted")
    expect(detail.app).toEqual(f.applied)
    expect(Effect.runSync(f.store.nextDelivery())).toBeUndefined()
    expect(Effect.runSync(f.conversations.recent())).toHaveLength(0)
  })
  it("rechecks exhaustion ownership inside the domain transaction", () => {
    const f = fixture()
    Effect.runSync(f.store.exhaustDelivery(() => false, false))
    expect(Effect.runSync(f.store.pending())).toHaveLength(1)
    Effect.runSync(f.store.exhaustDelivery(() => true, false))
    expect(Effect.runSync(f.store.pending())).toHaveLength(0)
  })
})
