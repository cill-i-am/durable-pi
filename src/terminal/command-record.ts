import { Schema } from "effect"

import { CommandRun } from "./contracts"
import { TerminalOccupancy, claimTerminalOccupancy } from "./occupancy.machine"

export const CommandRecord = Schema.Struct({
  ...CommandRun.fields,
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  attemptId: Schema.String,
  occupancy: TerminalOccupancy,
})
export type CommandRecord = typeof CommandRecord.Type
export function restoreCommandRecord(saved: unknown): CommandRecord {
  if (typeof saved !== "object" || saved === null)
    throw new Error("Invalid terminal command record")
  if ("schemaVersion" in saved || "workflowVersion" in saved)
    return Schema.decodeUnknownSync(CommandRecord)(saved)
  const legacy = Schema.decodeUnknownSync(CommandRun)(saved)
  const attemptId = `legacy:${legacy.id}`
  return Schema.decodeUnknownSync(CommandRecord)({
    ...legacy,
    schemaVersion: 1,
    workflowVersion: 1,
    revision: 0,
    attemptId,
    occupancy:
      legacy.status === "running"
        ? claimTerminalOccupancy(attemptId)
        : { state: "free", ownerId: null },
  })
}
