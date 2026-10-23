import { ObjectFailure, type ChangeSource } from "./contracts"

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
