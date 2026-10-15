import { Schema } from "effect"
import { TransferPlan } from "./transfers"

export const TerminalNetworkPolicy = Schema.Struct({
  revision: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0)
  ),
  unrestricted: Schema.Boolean,
})
export type TerminalNetworkPolicy = typeof TerminalNetworkPolicy.Type

export const CommandInput = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  command: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16000)
  ),
})
export type CommandInput = typeof CommandInput.Type
export const Checkpoint = Schema.Struct({
  key: Schema.String,
  sha256: Schema.String,
  size: Schema.Number,
  savedAt: Schema.Number,
})
export type Checkpoint = typeof Checkpoint.Type
export const CommandRun = Schema.Struct({
  ...CommandInput.fields,
  authorityRevision: Schema.optional(Schema.Number),
  networkUnrestricted: Schema.optional(Schema.Boolean),
  status: Schema.Literals([
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  kind: Schema.optional(
    Schema.Literals(["command", "session", "import", "export"])
  ),
  transfer: Schema.optional(TransferPlan),
  output: Schema.String,
  exitCode: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number),
  savedAt: Schema.NullOr(Schema.Number),
})
export type CommandRun = typeof CommandRun.Type
export const CommandSummary = Schema.Struct({
  id: CommandRun.fields.id,
  status: CommandRun.fields.status,
  createdAt: CommandRun.fields.createdAt,
  finishedAt: CommandRun.fields.finishedAt,
  savedAt: CommandRun.fields.savedAt,
  label: Schema.String,
})
export type CommandSummary = typeof CommandSummary.Type
export const InteractiveState = Schema.Struct({
  id: CommandInput.fields.id,
  phase: Schema.Literals(["starting", "ready", "saving"]),
  expiresAt: Schema.Number,
  maximumAt: Schema.Number,
})
export const TerminalState = Schema.Struct({
  networkPolicy: Schema.optional(TerminalNetworkPolicy),
  runs: Schema.Array(CommandSummary),
  savedAt: Schema.NullOr(Schema.Number),
  busy: Schema.Boolean,
  cleanupError: Schema.NullOr(Schema.String),
  session: Schema.NullOr(InteractiveState),
})
export class TerminalFailure extends Schema.TaggedError<TerminalFailure>()(
  "TerminalFailure",
  { message: Schema.String }
) {}
export class TerminalStorageError extends Schema.TaggedError<TerminalStorageError>()(
  "TerminalStorageError",
  {
    operation: Schema.String,
    cause: Schema.Unknown,
  }
) {}
export type TerminalState = typeof TerminalState.Type
export const MAX_OUTPUT = 64000
export const MAX_CHECKPOINT = 8 * 1024 * 1024
export const COMMAND_TIMEOUT = 30000
