import { Schema } from "effect"
import { CommunicationError, failure } from "../contracts"
import { nativeOperation } from "../../shared/interop"

/** A local Effect failure must implement the declared contract. An opaque
 * foreign rejection can only confirm that native state is unavailable. */
export const communicationNative = <T>(
  start: (signal: AbortSignal) => Promise<T>,
  code: "storage" | "transport" = "storage"
) =>
  nativeOperation(start, (cause, channel) => {
    const known = Schema.decodeUnknownOption(CommunicationError)(cause)
    if (known._tag === "Some") return known.value
    if (channel === "failure") throw cause
    return failure(
      code,
      code === "storage"
        ? "Pi task state is temporarily unavailable."
        : "Bot service is temporarily unavailable."
    )
  })
