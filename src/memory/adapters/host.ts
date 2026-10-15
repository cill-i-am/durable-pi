import { Schema } from "effect"
import { nativeOperation } from "../../shared/interop"
import { ConversationStorageError } from "../../conversations/turns"
import { MemoryStorageError } from "../domain"
import {
  MemorySchedulingError,
  type MemoryImportAuthority,
} from "../application"

export function memoryImportAuthority(
  transactionGroup: object,
  active: () => boolean
): MemoryImportAuthority {
  return {
    transactionGroup,
    active: () => {
      try {
        return active()
      } catch (cause) {
        const conversationStorageError = Schema.decodeUnknownOption(
          ConversationStorageError
        )(cause)
        if (conversationStorageError._tag === "Some")
          throw new MemoryStorageError({ operation: "read import authority" })
        throw cause
      }
    },
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
