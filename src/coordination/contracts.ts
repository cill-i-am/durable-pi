import { Schema } from "effect"

import { MessageProvenance } from "../messages/identity"

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
/** Addresses are local to the authenticated bot, never global lookup keys. */
export const Address = Schema.Struct({ sessionId: Id, agentId: Id })
export type Address = typeof Address.Type
export const SendMessage = Schema.Struct({
  to: Address,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8000)),
  replyTo: Schema.optional(Id),
})
export type SendMessage = typeof SendMessage.Type
export const Message = Schema.Struct({
  id: Id,
  operationId: Id,
  from: Address,
  ...SendMessage.fields,
  provenance: MessageProvenance,
  createdAt: Schema.Number,
  deadline: Schema.Number,
})
export type Message = typeof Message.Type
export type Agent = {
  address: Address
  name: string
  role: "main" | "child"
  status: "working" | "idle" | "stopped"
  nativeId: number
  deadline?: number
}
export type AgentReply = {
  id: string
  text: string
  createdAt: number
}
export class CoordinationFailure extends Schema.TaggedError<CoordinationFailure>()(
  "CoordinationFailure",
  {
    code: Schema.Literals([
      "invalid",
      "not_found",
      "forbidden",
      "closed",
      "limit",
      "conflict",
      "busy",
      "unavailable",
    ]),
    message: Schema.String,
  }
) {}
export const fail = (code: CoordinationFailure["code"], message: string) =>
  new CoordinationFailure({ code, message })
export const sameAgent = (a: Address, b: Address) =>
  a.sessionId === b.sessionId && a.agentId === b.agentId
export function canContact(from: Agent, to: Address) {
  return (
    from.address.sessionId === to.sessionId ||
    (from.role === "main" && to.agentId === "main")
  )
}
export function agentActor(bot: string, address: Address) {
  return {
    kind: "agent" as const,
    id: address.agentId === "main" ? bot : `${bot}/child/${address.agentId}`,
    sessionId: address.sessionId,
  }
}
