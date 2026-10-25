import { Effect, Schema } from "effect"

import { nativeFailure } from "../../shared/interop"
import type { BackgroundRemote } from "../background-service"
import { Group, Transcript } from "../contracts"
import {
  type BackgroundRequest,
  BackgroundOutcome,
} from "./background-protocol"
import { backgroundFailure, backgroundNative } from "./interop"

/** Start/Stop acknowledge independently owned durable remote work. Cancelling
 * observation cannot cancel that work, and waiting forever for its RPC promise
 * would defeat the persisted recovery deadline. These two calls own no local
 * resource cleanup. Other native/local operations retain their joined bridge. */
export function backgroundRemote(
  parentObject: string,
  stub: (id: number) => {
    invokeV1: (request: typeof BackgroundRequest.Type) => Promise<unknown>
  }
): BackgroundRemote {
  const invoke = <T>(
    id: number,
    request: typeof BackgroundRequest.Type,
    value: Schema.Codec<T>,
    observeOnly = false
  ) => {
    const call = () =>
      stub(id)
        .invokeV1(request)
        .then((raw) => BackgroundOutcome.unwrap(raw, value))
    if (!observeOnly) return backgroundNative(call)
    return Effect.tryPromise({
      try: call,
      catch: (cause) => nativeFailure(cause, backgroundFailure),
    }).pipe(Effect.catch((cause) => Effect.failCause(cause)))
  }
  return {
    start: (id) => invoke(id, { _tag: "Start", parentObject, id }, Group, true),
    read: (id) => invoke(id, { _tag: "Read" }, Group),
    stop: (id) =>
      invoke(id, { _tag: "Stop" }, Schema.Null, true).pipe(Effect.asVoid),
    control: (input) =>
      invoke(
        input.groupId,
        { _tag: "Control", input },
        Schema.Struct({ accepted: Schema.Boolean })
      ),
    transcript: (group, child, cursor) =>
      invoke(group, { _tag: "Transcript", child, cursor }, Transcript),
  }
}
