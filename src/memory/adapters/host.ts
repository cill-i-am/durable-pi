import { Effect, Schema } from "effect"

import type { ConversationError } from "../../conversations/service"
import { nativeOperation } from "../../shared/interop"
import {
  MemorySchedulingError,
  type MemoryImportAuthority,
} from "../application"
import { MemoryStorageError } from "../domain"

export function memoryImportAuthority(
  transactionGroup: object,
  active: () => Effect.Effect<boolean, ConversationError>
): MemoryImportAuthority {
  return {
    transactionGroup,
    active: () =>
      active().pipe(
        Effect.mapError(
          () => new MemoryStorageError({ operation: "read import authority" })
        )
      ),
  }
}
/** Lifecycle wake is a native foreign callback. Join its actual acknowledgment. */
export const memoryWake = (operation: string, wake: () => Promise<void>) =>
  nativeOperation(wake, (cause, channel) => {
    const expected = Schema.decodeUnknownOption(MemorySchedulingError)(cause)
    if (expected._tag === "Some") return expected.value
    if (
      channel === "failure" ||
      Schema.isSchemaError(cause) ||
      cause instanceof SyntaxError
    )
      throw cause
    return new MemorySchedulingError({ operation })
  })
