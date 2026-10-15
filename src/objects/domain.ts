import {
  ObjectFailure,
  type ChangeSource,
  type MutationReceipt,
} from "./contracts"
import type { ObjectOperation } from "./ledger"

export function requireObjectWritable(
  canWrite: (source: ChangeSource) => boolean,
  source: ChangeSource
) {
  if (!canWrite(source))
    throw new ObjectFailure({
      code: "read_only",
      message: "This bot or agent run can no longer change objects.",
    })
}
export function objectReplay(
  operation: ObjectOperation,
  digest: string
): MutationReceipt | undefined {
  if (operation.cancelled)
    throw new ObjectFailure({
      code: "cancelled",
      message: "This change was cancelled. Start a new edit.",
    })
  if (!operation.receipt) return undefined
  if (operation.digest !== digest)
    throw new ObjectFailure({
      code: "conflict",
      message: "This operation ID belongs to another change.",
    })
  // Native mutable views expire when their commit settles.
  return { ...operation.receipt }
}
export function requireObjectCapacity(
  operations: number,
  objects: number,
  creating: boolean
) {
  if (operations >= 20_000 || (creating && objects >= 50))
    throw new ObjectFailure({
      code: "limit",
      message:
        "This bot supports 50 objects and 20,000 changes, including archived objects.",
    })
}
export function requireObjectCancellationCapacity(operations: number) {
  if (operations >= 20_000)
    throw new ObjectFailure({
      code: "limit",
      message: "This bot has reached its object operation limit.",
    })
}
export const objectEventId = (id: string, revision: number) =>
  `${id}:${revision}`
export const objectOfferedThrough = (
  previous: number,
  offered: number,
  current: number
) => Math.max(previous, Math.min(offered, current))
