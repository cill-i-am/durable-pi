import { Schema } from "effect"

import { nativeOperation } from "../../shared/interop"
import { rpcOutcome } from "../../shared/rpc-outcome"
import { FileId, FileSelection } from "../../workspace/files"
import {
  IncomingWhatsApp,
  WhatsAppRejected,
  WhatsAppStorageError,
  WhatsAppTurn,
  WhatsAppUnavailable,
  WhatsAppImage,
  WhatsAppImageExport,
} from "../contracts"

export const WhatsAppRequest = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("ImportImage"),
    owner: Schema.String,
    id: IncomingWhatsApp.fields.id,
    image: WhatsAppImage,
  }),
  Schema.Struct({
    _tag: Schema.Literal("ExportImage"),
    owner: Schema.String,
    id: FileId,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Receive"),
    owner: Schema.String,
    input: IncomingWhatsApp,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Submit"),
    owner: Schema.String,
    input: Schema.Struct({
      id: IncomingWhatsApp.fields.id,
      body: IncomingWhatsApp.fields.body,
      sender: IncomingWhatsApp.fields.sender,
      messageId: IncomingWhatsApp.fields.messageId,
      files: Schema.optionalKey(FileSelection),
    }),
  }),
  Schema.Struct({
    _tag: Schema.Literal("Turn"),
    owner: Schema.String,
    id: IncomingWhatsApp.fields.id,
  }),
])
export const WhatsAppOutcome = rpcOutcome(
  Schema.Union([
    Schema.Boolean,
    Schema.NullOr(WhatsAppTurn),
    FileId,
    WhatsAppImageExport,
  ]),
  Schema.Union([WhatsAppRejected, WhatsAppStorageError, WhatsAppUnavailable]),
  "WhatsApp operation failed unexpectedly."
)
export interface WhatsAppRpc {
  whatsappV1: (input: typeof WhatsAppRequest.Type) => Promise<unknown>
}
export const whatsappNative = <T>(work: () => Promise<T>) =>
  nativeOperation(work, (cause, channel) => {
    if (channel === "failure" || Schema.isSchemaError(cause)) throw cause
    return new WhatsAppUnavailable()
  })
export const whatsappRpc = (peer: WhatsAppRpc) => ({
  importImage: (owner: string, id: string, image: WhatsAppImage) =>
    peer
      .whatsappV1({ _tag: "ImportImage", owner, id, image })
      .then((raw) => WhatsAppOutcome.unwrap(raw, FileId)),
  exportImage: (owner: string, id: string) =>
    peer
      .whatsappV1({ _tag: "ExportImage", owner, id })
      .then((raw) => WhatsAppOutcome.unwrap(raw, WhatsAppImageExport)),
  receive: (owner: string, input: typeof IncomingWhatsApp.Type) =>
    peer
      .whatsappV1({ _tag: "Receive", owner, input })
      .then((raw) => WhatsAppOutcome.unwrap(raw, Schema.Boolean)),
  submit: (
    owner: string,
    input: Extract<typeof WhatsAppRequest.Type, { _tag: "Submit" }>["input"]
  ) =>
    peer
      .whatsappV1({ _tag: "Submit", owner, input })
      .then((raw) => WhatsAppOutcome.unwrap(raw, Schema.Boolean)),
  turn: (owner: string, id: string) =>
    peer
      .whatsappV1({ _tag: "Turn", owner, id })
      .then((raw) => WhatsAppOutcome.unwrap(raw, Schema.NullOr(WhatsAppTurn))),
})
