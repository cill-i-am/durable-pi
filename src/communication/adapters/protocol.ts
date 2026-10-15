import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Envelope, Receipt, CommunicationError } from "../contracts"

export class MailboxRpc extends RpcGroup.make(
  Rpc.make("deliver", {
    payload: { envelope: Envelope },
    success: Receipt,
    error: CommunicationError,
  }),
  Rpc.make("permit", {
    payload: { envelope: Envelope },
    success: Schema.Boolean,
    error: CommunicationError,
  }),
  Rpc.make("prove", {
    payload: { envelope: Envelope },
    success: Schema.Boolean,
    error: CommunicationError,
  })
) {}
