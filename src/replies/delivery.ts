import { Effect } from "effect"

import { preserveFatal } from "../shared/effect"
import {
  ReplySendFailed,
  type ReplyPart,
  type ReplyProgress,
} from "./contracts"

export interface ReplyTransport<E> {
  claim: (
    progress: ReplyProgress,
    from: "waiting" | "sending"
  ) => Effect.Effect<boolean, E>
  checkpoint: (progress: ReplyProgress) => Effect.Effect<boolean, E>
  send: (part: ReplyPart) => Effect.Effect<string, ReplySendFailed>
  finish: (
    state: "sent" | "failed" | "uncertain",
    providerId: string | null
  ) => Effect.Effect<unknown, E>
}

/** Each claim and checkpoint commits in the owning actor. One part is one
 * provider message: never hide SDK multi-send behavior behind one receipt. */
export function deliverReply<E>(
  initial: ReplyProgress,
  transport: ReplyTransport<E>
) {
  return Effect.gen(function* () {
    let progress = initial
    let from: "waiting" | "sending" = "waiting"
    if (
      progress.receipts.length > progress.parts.length ||
      !progress.parts.length
    )
      throw new Error("Invalid persisted reply progress")
    for (const part of progress.parts.slice(progress.receipts.length)) {
      if (!(yield* transport.claim(progress, from))) return
      from = "sending"
      const result = yield* transport
        .send(part)
        .pipe(preserveFatal, Effect.result)
      if (result._tag === "Failure") {
        yield* transport.finish(
          result.failure.uncertain ? "uncertain" : "failed",
          null
        )
        return
      }
      progress = {
        ...progress,
        receipts: [...progress.receipts, result.success],
      }
      if (!(yield* transport.checkpoint(progress))) return
    }
    // A crash after the last checkpoint needs no additional provider send.
    if (from === "waiting" && !(yield* transport.claim(progress, from))) return
    yield* transport.finish("sent", progress.receipts.at(-1) ?? null)
  })
}
