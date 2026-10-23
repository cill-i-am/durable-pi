import { Context, Schema, type Effect } from "effect"

import type { MessageProvenance } from "../messages/identity"
import type { TimelineItem } from "./contracts"
import type { Turn, TurnOutcome } from "./turns"

export class ConversationExecutionError extends Schema.TaggedError<ConversationExecutionError>()(
  "ConversationExecutionError",
  { operation: Schema.String, cause: Schema.Unknown }
) {}

export class ConversationControlTimeout extends Schema.TaggedError<ConversationControlTimeout>()(
  "ConversationControlTimeout",
  { phase: Schema.Literals(["handoff", "observe", "stop"]) }
) {}

/** Facts from one captured transcript and its committed submission receipts.
 * A newer completion receipt does not establish that this transcript is settled. */
export interface ConversationObservation {
  readonly settled: boolean
  /** Native request receipts captured with this observation; absent only in legacy test adapters. */
  readonly accepted?: readonly string[]
  readonly answer: string
  readonly liveAnswer: string
  readonly activity: readonly TimelineItem[]
  readonly archivedActivity: readonly TimelineItem[]
  readonly archives: readonly {
    source: string
    kind: "user" | "talk" | "tool" | "echo" | "note"
    text: string
    date?: string
    provenance?: MessageProvenance
  }[]
  readonly consumed: readonly string[]
  readonly outcomes: readonly TurnOutcome[]
}

export class ConversationExecution extends Context.Service<
  ConversationExecution,
  {
    readonly observe: (
      root: Turn,
      members: readonly Turn[]
    ) => Effect.Effect<ConversationObservation, ConversationExecutionError>
    readonly steer: (
      session: string,
      member: Turn
    ) => Effect.Effect<void, ConversationExecutionError>
    readonly abort: (
      session: string
    ) => Effect.Effect<void, ConversationExecutionError>
    readonly createSession: () => Effect.Effect<
      string,
      ConversationExecutionError
    >
    readonly configure: (
      session: string,
      turn: Turn
    ) => Effect.Effect<void, ConversationExecutionError>
    readonly submit: (
      session: string,
      turn: Turn
    ) => Effect.Effect<void, ConversationExecutionError>
  }
>()("durable-pi/conversations/ConversationExecution") {}
