import { Effect, Schema } from "effect"

import { nativeFailure, nativeOperation } from "../../shared/interop"
import { rpcOutcome } from "../../shared/rpc-outcome"
import { FileId, FileSelection } from "../../workspace/files"
import {
  IncomingWhatsApp,
  WhatsAppRejected,
  WhatsAppStorageError,
  WhatsAppTurn,
  WhatsAppUnavailable,
  WhatsAppMedia,
  WhatsAppMediaExport,
} from "../contracts"

export const WhatsAppRequest = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("ImportMedia"),
    owner: Schema.String,
    id: IncomingWhatsApp.fields.id,
    media: WhatsAppMedia,
  }),
  Schema.Struct({
    _tag: Schema.Literal("ExportMedia"),
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
const WhatsAppFailure = Schema.Union([
  WhatsAppRejected,
  WhatsAppStorageError,
  WhatsAppUnavailable,
])
export const WhatsAppOutcome = rpcOutcome(
  Schema.Union([
    Schema.Boolean,
    Schema.NullOr(WhatsAppTurn),
    FileId,
    WhatsAppMediaExport,
  ]),
  WhatsAppFailure,
  "WhatsApp operation failed unexpectedly."
)
export interface WhatsAppRpc {
  whatsappV1: (input: typeof WhatsAppRequest.Type) => Promise<unknown>
}
const whatsappFailure = (cause: unknown, channel: "failure" | "rejection") => {
  if (channel === "failure" || Schema.isSchemaError(cause)) throw cause
  return new WhatsAppUnavailable()
}
export const whatsappNative = <T>(work: () => Promise<T>) =>
  nativeOperation(work, whatsappFailure)

const whatsappRemoteFailure = (
  cause: unknown,
  channel: "failure" | "rejection"
) => {
  const known = Schema.decodeUnknownOption(WhatsAppFailure)(cause)
  return known._tag === "Some" ? known.value : whatsappFailure(cause, channel)
}

/** These remote RPCs expose no local resource or cancellation handle. A reply
 * deadline may stop observing; remote acceptance remains correlated by the
 * existing message/operation ID and must never be treated as confirmed. */
export const whatsappRemote = <T>(work: () => Promise<T>) =>
  Effect.suspend(() => {
    const pending = work()
    return Effect.tryPromise({
      try: () => pending,
      catch: (cause) => nativeFailure(cause, whatsappRemoteFailure),
    }).pipe(Effect.catch((cause) => Effect.failCause(cause)))
  })
export const whatsappRpc = (peer: WhatsAppRpc) => ({
  importMedia: (owner: string, id: string, media: WhatsAppMedia) =>
    peer
      .whatsappV1({ _tag: "ImportMedia", owner, id, media })
      .then((raw) => WhatsAppOutcome.unwrap(raw, FileId)),
  exportMedia: (owner: string, id: string) =>
    peer
      .whatsappV1({ _tag: "ExportMedia", owner, id })
      .then((raw) => WhatsAppOutcome.unwrap(raw, WhatsAppMediaExport)),
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
