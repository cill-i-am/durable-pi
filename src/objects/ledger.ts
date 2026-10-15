import type { Effect } from "effect"
import type {
  Checklist,
  MutationReceipt,
  ObjectEvent,
  ObjectFailure,
} from "./contracts"

export interface ObjectCatalog {
  ids: string[]
  sequence: number
  offeredThrough: number
  operations: number
}
export interface ObjectOperation {
  digest: string
  cancelled: boolean
  receipt: MutationReceipt | null
}
/** Mutable views belong exclusively to this native commit callback. */
export interface ObjectTransaction {
  catalog: () => Effect.Effect<ObjectCatalog, ObjectFailure>
  checklist: (
    id: string
  ) => Effect.Effect<{ value: Checklist | null }, ObjectFailure>
  event: (
    id: string
  ) => Effect.Effect<{ value: ObjectEvent | null }, ObjectFailure>
  operation: (id: string) => Effect.Effect<ObjectOperation, ObjectFailure>
}
export interface ObjectLedger {
  atomic: <T, TError, TRequirements>(
    change: (tx: ObjectTransaction) => Effect.Effect<T, TError, TRequirements>
  ) => Effect.Effect<T, TError | ObjectFailure, TRequirements>
  checklist: (id: string) => Effect.Effect<Checklist | null, ObjectFailure>
  event: (id: string) => Effect.Effect<ObjectEvent | null, ObjectFailure>
}
export type ObjectDigest = (
  value: unknown
) => Effect.Effect<string, ObjectFailure>
