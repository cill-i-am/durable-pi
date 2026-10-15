import { Effect, Schema } from "effect"
import type { BackgroundRemote } from "../background-service"
import { Group, Transcript } from "../contracts"
import { backgroundNative } from "./interop"
import {
  type BackgroundRequest,
  BackgroundOutcome,
} from "./background-protocol"

/** Native DO RPC cannot cancel an admitted remote call. Join its local
 * settlement; the remote durable group remains fenced by parent authority. */
export function backgroundRemote(
  parentObject: string,
  stub: (id: number) => {
    invokeV1: (request: typeof BackgroundRequest.Type) => Promise<unknown>
  }
): BackgroundRemote {
  const invoke = <T>(
    id: number,
    request: typeof BackgroundRequest.Type,
    value: Schema.Codec<T>
  ) =>
    backgroundNative(() =>
      stub(id)
        .invokeV1(request)
        .then((raw) => BackgroundOutcome.unwrap(raw, value))
    )
  return {
    start: (id) => invoke(id, { _tag: "Start", parentObject, id }, Group),
    read: (id) => invoke(id, { _tag: "Read" }, Group),
    stop: (id) => invoke(id, { _tag: "Stop" }, Schema.Null).pipe(Effect.asVoid),
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
