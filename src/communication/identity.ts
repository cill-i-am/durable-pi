import { Context, type Effect } from "effect"
import type { CommunicationError } from "./contracts"

/** Stable across retries and adapter changes: the existing continuation UUID
 * belongs to durable conversation admission, not to an individual invocation. */
export class ContinuationIdentity extends Context.Service<
  ContinuationIdentity,
  {
    derive: (taskId: string) => Effect.Effect<string, CommunicationError>
  }
>()("durable-pi/communication/ContinuationIdentity") {}

export function continuationUuid(digest: Uint8Array): string {
  if (digest.length !== 32)
    throw new RangeError("Continuation identity requires a SHA-256 digest")
  const bytes = digest.slice(0, 16)
  bytes[6] = (bytes[6]! & 15) | 64
  bytes[8] = (bytes[8]! & 63) | 128
  const text = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`
}
