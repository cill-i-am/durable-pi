import { Effect, Schema } from "effect"
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import {
  defineDoc,
  defineDocFamily,
  type Session,
  type Tx,
} from "@earendil-works/pi-durable"
import {
  Checklist,
  ObjectEvent,
  ObjectFailure,
  ObjectMutation,
  ChangeSource,
  ObjectId,
  OperationId,
  MutationReceipt,
  Revision,
  objectSummary,
  type ChecklistTask,
  type FieldChange,
} from "../contracts"
import type { WorkingObjects } from "../objects"
import { changeChecklist } from "../checklist"

// Session scope is the bot's native Harness, shared by all its per-turn conversations.
const Catalog = defineDoc({
  kind: "working-objects.catalog",
  scope: "session",
  version: 1,
  initial: () => ({
    ids: [] as string[],
    sequence: 0,
    offeredThrough: 0,
    operations: 0,
  }),
})
const Objects = defineDocFamily({
  kind: "working-objects.checklist",
  scope: "session",
  family: true,
  version: 1,
  initial: (_seed: null) => ({
    value: null as
      (Omit<Checklist, "tasks"> & { tasks: ChecklistTask[] }) | null,
  }),
})
const Events = defineDocFamily({
  kind: "working-objects.event",
  scope: "session",
  family: true,
  version: 1,
  initial: (_seed: null) => ({
    value: null as
      (Omit<ObjectEvent, "changes"> & { changes: FieldChange[] }) | null,
  }),
})
const Operations = defineDocFamily({
  kind: "working-objects.operation",
  scope: "session",
  family: true,
  version: 1,
  initial: (
    _seed: null
  ): {
    digest: string
    cancelled: boolean
    receipt: MutationReceipt | null
  } => ({ digest: "", cancelled: false, receipt: null }),
})
/** Read through the caller's native transaction; never nest Session.snapshot in a commit. */
export async function checklistInTransaction(tx: Tx, id: string) {
  return (await tx.doc(Objects, id, null)).value
}
const eventKey = (id: string, revision: number) => `${id}:${revision}`
const invalid = () =>
  new ObjectFailure({
    code: "invalid",
    message: "Check the checklist fields, IDs, dates and revision.",
  })
const decode = <T>(body: () => T) => {
  try {
    return body()
  } catch {
    throw invalid()
  }
}
const attempt = <T>(body: () => Promise<T>) =>
  Effect.tryPromise({
    try: body,
    catch: (cause) =>
      cause instanceof ObjectFailure
        ? cause
        : new ObjectFailure({
            code: "unavailable",
            message:
              "The saved state could not be confirmed. Retry the same change.",
          }),
  })
const hash = async (value: unknown) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value))
      )
    ),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("")

export function piWorkingObjects(
  open: () => Promise<Session>,
  canWrite: (source: ChangeSource) => boolean
): WorkingObjects {
  const writable = (source: ChangeSource) => {
    if (!canWrite(source))
      throw new ObjectFailure({
        code: "read_only",
        message: "This bot or agent run can no longer change objects.",
      })
  }
  const contextSnapshot = () =>
    attempt(async () => {
      const session = await open()
      return session.commit(async (tx) => {
        const catalog = await tx.doc(Catalog)
        const objects = []
        for (const id of catalog.ids) {
          const value = (await tx.doc(Objects, id, null)).value
          if (value) objects.push(objectSummary(value))
        }
        return {
          sequence: catalog.sequence,
          offeredThrough: catalog.offeredThrough,
          objects,
        }
      }, context)
    })
  return {
    context: contextSnapshot,
    list: () =>
      contextSnapshot().pipe(Effect.map((snapshot) => snapshot.objects)),
    read: (raw, before) =>
      attempt(async () => {
        const id = decode(() => Schema.decodeUnknownSync(ObjectId)(raw))
        if (before !== undefined)
          decode(() => Schema.decodeUnknownSync(Revision)(before))
        const session = await open(),
          stored = await session.snapshot(Objects, id, context)
        if (!stored?.value)
          throw new ObjectFailure({
            code: "not_found",
            message: "This checklist is unavailable in this bot.",
          })
        const object = Schema.decodeUnknownSync(Checklist)(stored.value)
        const events: ObjectEvent[] = []
        const from = Math.min(
          object.revision,
          before === undefined ? object.revision : before - 1
        )
        for (
          let revision = from;
          revision > Math.max(0, from - 20);
          revision--
        ) {
          const event = await session.snapshot(
            Events,
            eventKey(id, revision),
            context
          )
          if (event?.value)
            events.push(Schema.decodeUnknownSync(ObjectEvent)(event.value))
        }
        return { object, events, nextHistory: from > 20 ? from - 19 : null }
      }),
    mutate: (raw, origin) =>
      attempt(async () => {
        const input = decode(() =>
            Schema.decodeUnknownSync(ObjectMutation)(raw)
          ),
          source = decode(() => Schema.decodeUnknownSync(ChangeSource)(origin)),
          digest = await hash({ input, source }),
          session = await open()
        return session.commit(async (tx) => {
          writable(source)
          const operation = await tx.doc(Operations, input.operationId, null)
          if (operation.cancelled)
            throw new ObjectFailure({
              code: "cancelled",
              message: "This change was cancelled. Start a new edit.",
            })
          if (operation.receipt) {
            if (operation.digest !== digest)
              throw new ObjectFailure({
                code: "conflict",
                message: "This operation ID belongs to another change.",
              })
            return Schema.decodeUnknownSync(MutationReceipt)(operation.receipt)
          }
          const catalog = await tx.doc(Catalog),
            stored = await tx.doc(Objects, input.id, null)
          if (
            catalog.operations >= 20000 ||
            (!stored.value && catalog.ids.length >= 50)
          )
            throw new ObjectFailure({
              code: "limit",
              message:
                "This bot supports 50 objects and 20,000 changes, including archived objects.",
            })
          const { value, changes } = changeChecklist(
            stored.value ?? undefined,
            input,
            source,
            new Date().toISOString(),
            catalog.sequence + 1
          )
          const id = eventKey(value.id, value.revision)
          const event = changes.length ? await tx.doc(Events, id, null) : null
          // Recheck after asynchronous document reads; revocation/Stop may have arrived meanwhile.
          writable(source)
          if (event) {
            event.value = {
              id,
              objectId: value.id,
              revision: value.revision,
              sequence: value.lastEvent,
              source,
              at: value.updatedAt,
              changes,
            }
            catalog.sequence = value.lastEvent
          }
          if (!stored.value) catalog.ids.push(value.id)
          stored.value = { ...value, tasks: [...value.tasks] }
          catalog.operations++
          const receipt = {
            objectId: value.id,
            revision: value.revision,
            eventId: id,
          }
          operation.digest = digest
          operation.receipt = receipt
          return receipt
        }, context)
      }),
    cancel: (raw) =>
      attempt(async () => {
        const id = decode(() => Schema.decodeUnknownSync(OperationId)(raw)),
          session = await open()
        return session.commit(async (tx) => {
          const source = {
            actor: "user" as const,
            surface: "workbench" as const,
            turnId: null,
            toolCallId: null,
          }
          writable(source)
          const operation = await tx.doc(Operations, id, null),
            catalog = await tx.doc(Catalog)
          if (operation.receipt) return { applied: true }
          if (!operation.cancelled) {
            if (catalog.operations >= 20000)
              throw new ObjectFailure({
                code: "limit",
                message: "This bot has reached its object operation limit.",
              })
            writable(source)
            operation.cancelled = true
            catalog.operations++
          }
          return { applied: false }
        }, context)
      }),
    offered: (sequence) =>
      attempt(async () => {
        decode(() => Schema.decodeUnknownSync(Revision)(sequence))
        const session = await open()
        await session.commit(async (tx) => {
          const catalog = await tx.doc(Catalog)
          catalog.offeredThrough = Math.max(
            catalog.offeredThrough,
            Math.min(sequence, catalog.sequence)
          )
        }, context)
      }),
  }
}
