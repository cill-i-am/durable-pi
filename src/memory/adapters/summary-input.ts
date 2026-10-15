import { preserveFatal } from "../../shared/effect"
import { Schema, Effect } from "effect"
import { AgentConflict, AgentStorageError } from "../../agents/domain"
import { ConversationExecutionError } from "../../conversations/execution"
import { ConversationStorageError } from "../../conversations/turns"
import { ModelUnavailable } from "../../inference/policy"
import { InvalidMemory, MemoryNotReady, MemoryStorageError } from "../domain"
import { SummaryFailure } from "../summary-model"

/** Normalize expected source failures; an unexpected source error stays a defect. */
export const summaryInput = <TValue, TError, TRequirements>(
  operation: Effect.Effect<TValue, TError, TRequirements>
) =>
  operation.pipe(
    preserveFatal,
    Effect.mapError((cause) => {
      const knownFailure = Schema.decodeUnknownOption(
        Schema.Union([
          MemoryStorageError,
          InvalidMemory,
          MemoryNotReady,
          SummaryFailure,
        ])
      )(cause)
      if (knownFailure._tag === "Some") return knownFailure.value
      const knownFailure2 = Schema.decodeUnknownOption(
        Schema.Union([AgentStorageError, ConversationStorageError])
      )(cause)
      if (knownFailure2._tag === "Some")
        return new MemoryStorageError({ operation: "read summary input" })
      const knownFailure3 = Schema.decodeUnknownOption(
        Schema.Union([ModelUnavailable, ConversationExecutionError])
      )(cause)
      if (knownFailure3._tag === "Some")
        return new SummaryFailure({ reason: "unavailable" })
      const agentConflict = Schema.decodeUnknownOption(AgentConflict)(cause)
      if (agentConflict._tag === "Some")
        return new InvalidMemory({
          message: "Could not read summary model authority.",
        })
      throw cause
    })
  )
