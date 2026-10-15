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
  ObjectId,
  MutationReceipt,
  Revision,
  type ChecklistTask,
  type FieldChange,
  type ChangeSource,
} from "../contracts"
import type { ObjectLedger, ObjectTransaction } from "../ledger"
import { nativeOperation } from "../../shared/interop"
import { nativeCommit } from "../../shared/adapters/native-commit"
import { makeWorkingObjects } from "../service"

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
const CatalogRecord = Schema.Struct({
  ids: Schema.Array(ObjectId),
  sequence: Revision,
  offeredThrough: Revision,
  operations: Revision,
})
const OperationRecord = Schema.Struct({
  digest: Schema.String,
  cancelled: Schema.Boolean,
  receipt: Schema.NullOr(MutationReceipt),
})

/** Join native I/O on cancellation; decoding belongs outside this conversion. */
const objectRejected = (cause: unknown, channel: "failure" | "rejection") => {
  const expected = Schema.decodeUnknownOption(ObjectFailure)(cause)
  if (expected._tag === "Some") return expected.value
  if (
    channel === "failure" ||
    Schema.isSchemaError(cause) ||
    cause instanceof SyntaxError
  )
    throw cause
  return new ObjectFailure({
    code: "unavailable",
    message: "The saved state could not be confirmed. Retry the same change.",
  })
}
export const objectNativeOperation = <T>(
  start: (signal: AbortSignal) => Promise<T>
) => nativeOperation(start, objectRejected)

export const checklistInTransaction = (tx: Tx, id: string) =>
  objectNativeOperation(() => tx.doc(Objects, id, null)).pipe(
    Effect.map((doc) =>
      doc.value ? Schema.decodeUnknownSync(Checklist)(doc.value) : null
    )
  )
const transaction = (tx: Tx): ObjectTransaction => ({
  catalog: () =>
    objectNativeOperation(() => tx.doc(Catalog)).pipe(
      Effect.map((doc) => {
        Schema.decodeUnknownSync(CatalogRecord)(doc)
        return doc
      })
    ),
  checklist: (id) =>
    objectNativeOperation(() => tx.doc(Objects, id, null)).pipe(
      Effect.map((doc) => {
        if (doc.value) Schema.decodeUnknownSync(Checklist)(doc.value)
        return doc
      })
    ),
  event: (id) =>
    objectNativeOperation(() => tx.doc(Events, id, null)).pipe(
      Effect.map((doc) => {
        if (doc.value) Schema.decodeUnknownSync(ObjectEvent)(doc.value)
        return doc
      })
    ),
  operation: (id) =>
    objectNativeOperation(() => tx.doc(Operations, id, null)).pipe(
      Effect.map((doc) => {
        Schema.decodeUnknownSync(OperationRecord)(doc)
        return doc
      })
    ),
})

export function piObjectLedger(open: () => Promise<Session>): ObjectLedger {
  return {
    atomic: <T, TError, TRequirements>(
      change: (tx: ObjectTransaction) => Effect.Effect<T, TError, TRequirements>
    ) =>
      objectNativeOperation(open).pipe(
        Effect.flatMap((session) =>
          nativeCommit<Tx, T, TError, TRequirements, ObjectFailure>(
            (body, signal) =>
              session.commit(body, { ...context, abortSignal: signal }),
            (tx) => change(transaction(tx)),
            objectRejected
          )
        )
      ),
    checklist: (id) =>
      objectNativeOperation(open).pipe(
        Effect.flatMap((session) =>
          objectNativeOperation((signal) =>
            session.snapshot(Objects, id, { ...context, abortSignal: signal })
          )
        ),
        Effect.map((doc) =>
          doc?.value ? Schema.decodeUnknownSync(Checklist)(doc.value) : null
        )
      ),
    event: (id) =>
      objectNativeOperation(open).pipe(
        Effect.flatMap((session) =>
          objectNativeOperation((signal) =>
            session.snapshot(Events, id, { ...context, abortSignal: signal })
          )
        ),
        Effect.map((doc) =>
          doc?.value ? Schema.decodeUnknownSync(ObjectEvent)(doc.value) : null
        )
      ),
  }
}
export const objectDigest = (value: unknown) =>
  objectNativeOperation(() =>
    crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(value))
    )
  ).pipe(
    Effect.map((bytes) =>
      Array.from(new Uint8Array(bytes), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("")
    )
  )
export const piWorkingObjects = (
  open: () => Promise<Session>,
  canWrite: (source: ChangeSource) => boolean
) => makeWorkingObjects(piObjectLedger(open), canWrite, objectDigest)
