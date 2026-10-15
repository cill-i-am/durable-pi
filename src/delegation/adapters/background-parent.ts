import { Schema } from "effect"
import {
  AccountToken,
  AccountFailure,
} from "../../inference/adapters/account-rpc"
import { rpcOutcome } from "../../shared/rpc-outcome"
import { BackgroundHandoff } from "../background"
import { DelegationFailure, NativeId } from "../contracts"

export const BackgroundParentRequest = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Authorized"), id: NativeId }),
  Schema.Struct({ _tag: Schema.Literal("Handoff"), id: NativeId }),
  Schema.Struct({
    _tag: Schema.Literal("Credential"),
    id: NativeId,
    provider: Schema.String,
  }),
])
export const BackgroundParentResult = Schema.Union([
  Schema.Boolean,
  BackgroundHandoff,
  Schema.NullOr(AccountToken),
])
export const BackgroundParentFailure = Schema.Union([
  DelegationFailure,
  AccountFailure,
])
export const BackgroundParentOutcome = rpcOutcome(
  BackgroundParentResult,
  BackgroundParentFailure,
  "Background parent operation failed unexpectedly."
)

export function backgroundParentRpc(stub: {
  backgroundParentV1: (
    input: typeof BackgroundParentRequest.Type
  ) => Promise<unknown>
}) {
  return {
    authorized: (id: number) =>
      stub
        .backgroundParentV1({ _tag: "Authorized", id })
        .then((raw) => BackgroundParentOutcome.unwrap(raw, Schema.Boolean)),
    handoff: (id: number) =>
      stub
        .backgroundParentV1({ _tag: "Handoff", id })
        .then((raw) => BackgroundParentOutcome.unwrap(raw, BackgroundHandoff)),
    credential: (id: number, provider: string) =>
      stub
        .backgroundParentV1({ _tag: "Credential", id, provider })
        .then((raw) =>
          BackgroundParentOutcome.unwrap(raw, Schema.NullOr(AccountToken))
        ),
  }
}
