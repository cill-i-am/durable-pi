import { Schema } from "effect"
import { rpcOutcome } from "../../shared/rpc-outcome"
import {
  Control,
  DelegationFailure,
  Group,
  NativeId,
  Transcript,
} from "../contracts"

export const BackgroundRequest = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Start"),
    parentObject: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    id: NativeId,
  }),
  Schema.Struct({ _tag: Schema.Literal("Read") }),
  Schema.Struct({ _tag: Schema.Literal("Stop") }),
  Schema.Struct({ _tag: Schema.Literal("Control"), input: Control }),
  Schema.Struct({
    _tag: Schema.Literal("Transcript"),
    child: NativeId,
    cursor: Schema.optional(Schema.String),
  }),
])

export const BackgroundResult = Schema.Union([
  Group,
  Transcript,
  Schema.Struct({ accepted: Schema.Boolean }),
  Schema.Null,
])

export const BackgroundOutcome = rpcOutcome(
  BackgroundResult,
  DelegationFailure,
  "Background task operation failed unexpectedly."
)
export const backgroundReply = BackgroundOutcome.encode
