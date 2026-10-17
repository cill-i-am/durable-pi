import { Clock, Effect, Schema } from "effect"

import type { AgentId } from "../agents/domain"
import type { Submission } from "../conversations/turns"
import { preserveFatal } from "../shared/effect"
import type { WhatsAppStore } from "./adapters/sqlite"
import {
  whatsappIdentity,
  WhatsAppUnavailable,
  WHATSAPP_WINDOW_MS,
  type WhatsAppFailure,
  type WhatsAppRecord,
  type WhatsAppTurn,
} from "./contracts"

export class WhatsAppSendFailed extends Schema.TaggedError<WhatsAppSendFailed>()(
  "WhatsAppSendFailed",
  { uncertain: Schema.Boolean }
) {}
export interface WhatsAppPumpHost {
  image?: (record: WhatsAppRecord) => Effect.Effect<string, WhatsAppFailure>
  active: (id: AgentId) => Effect.Effect<boolean, WhatsAppFailure>
  admit: (
    id: AgentId,
    input: Submission
  ) => Effect.Effect<unknown, WhatsAppFailure>
  turn: (
    id: AgentId,
    turnId: string
  ) => Effect.Effect<WhatsAppTurn | undefined, WhatsAppFailure>
  name: (id: AgentId) => Effect.Effect<string, WhatsAppFailure>
  send: (
    record: WhatsAppRecord,
    reply: string
  ) => Effect.Effect<string, WhatsAppSendFailed>
  reviewUrl: (id: AgentId) => string
}
export function whatsappPump(records: WhatsAppStore, host: WhatsAppPumpHost) {
  const send = Effect.fn("WhatsApp.sendReply")(function* (
    record: WhatsAppRecord,
    text: string
  ) {
    const name = yield* host.name(record.agentId)
    const reply = record.outboundImageId
      ? `${name}\n\n${text}`.slice(0, 500)
      : `${name}\n\n${text.slice(0, 3000)}${text.length > 3000 ? "\n\nContinued in Pi." : ""}\n\n${host.reviewUrl(record.agentId)}`.slice(
          0,
          3900
        )
    if (
      !(yield* records.claim(record, reply, () => host.active(record.agentId)))
    )
      return
    yield* host.send(record, reply).pipe(
      preserveFatal,
      Effect.flatMap((providerId) =>
        records.update(record.id, "sending", "sent", { providerId })
      ),
      Effect.catchTag("WhatsAppSendFailed", (failure) =>
        records.update(
          record.id,
          "sending",
          failure.uncertain ? "uncertain" : "failed",
          {
            error: failure.uncertain
              ? "Delivery could not be confirmed. Check WhatsApp before retrying."
              : "This reply could not be sent. Review the connection, source image and reply window before retrying.",
          }
        )
      )
    )
  })
  const notice = Effect.fn("WhatsApp.approvalNotice")(function* (
    record: WhatsAppRecord
  ) {
    const identity = yield* Effect.promise(() =>
      whatsappIdentity(`${record.id}:approval`)
    )
    yield* records
      .receive(
        {
          ...record,
          ...identity,
          messageId: `approval:${record.id}`,
          body: "Approval notification",
          image: null,
        },
        record.agentId,
        {
          reply:
            "An action needs your approval. Open Pi to review it. WhatsApp messages cannot approve actions.",
        }
      )
      .pipe(Effect.catchTag("WhatsAppRejected", () => Effect.void))
  })
  const prepareImage = Effect.fn("WhatsApp.prepareImage")(function* (
    record: WhatsAppRecord
  ) {
    let imageFileId = record.imageFileId
    if (record.image && !imageFileId) {
      if (!(yield* records.beginImage(record.id))) return undefined
      const imported = yield* (
        host.image ? host.image(record) : Effect.fail(new WhatsAppUnavailable())
      ).pipe(
        Effect.map((id) => ({ id })),
        Effect.catchTag("WhatsAppRejected", (error) =>
          records
            .update(record.id, "queued", "failed", { error: error.message })
            .pipe(Effect.as(undefined))
        )
      )
      if (!imported) return undefined
      imageFileId = imported.id
      if (
        !(yield* records.update(record.id, "queued", "queued", {
          imageFileId,
        }))
      )
        return undefined
    }
    return imageFileId ? [imageFileId] : []
  })
  const process = Effect.fn("WhatsApp.process")(function* (
    record: WhatsAppRecord
  ) {
    const settings = yield* records.settings()
    if (
      !settings.enabled ||
      settings.generation !== record.generation ||
      !(yield* host.active(record.agentId))
    ) {
      yield* records.update(record.id, record.state, "cancelled", {
        error:
          "WhatsApp is disabled or this agent is archived. The conversation remains in Pi.",
      })
      return
    }
    if (Date.now() - settings.lastInboundAt >= WHATSAPP_WINDOW_MS) {
      yield* records.update(record.id, record.state, "expired", {
        error:
          "The WhatsApp reply window closed. Review the conversation in Pi.",
      })
      return
    }
    if (record.control) {
      yield* send(record, record.reply)
      return
    }
    if (record.state === "queued") {
      const files = yield* prepareImage(record)
      if (!files) return
      yield* host.admit(record.agentId, {
        operationId: record.id,
        text: record.body,
        mode: "followUp",
        files,
        origin: {
          kind: "whatsapp",
          sender: record.sender,
          messageId: record.messageId,
        },
      })
      yield* records.update(record.id, "queued", "waiting")
      return
    }
    const turn = yield* host.turn(record.agentId, record.id)
    if (!turn) return
    if (turn.needsApproval) yield* notice(record)
    if (["done", "failed", "cancelled"].includes(turn.status)) {
      for (const id of turn.status === "done" ? (turn.images ?? []) : [])
        yield* records.queueImage(record, id)
      yield* send(
        record,
        turn.status === "done" && turn.answer.trim()
          ? turn.answer
          : "This request could not finish. Open Pi to review the conversation."
      )
    }
  })
  return Effect.fn("WhatsApp.pump")(function* () {
    for (const record of yield* records.pending()) {
      if (record.state === "sending") continue
      yield* process(record).pipe(
        preserveFatal,
        Effect.catchTags({
          WhatsAppUnavailable: () => Effect.void,
          WhatsAppRejected: () => Effect.void,
        })
      )
    }
    if ((yield* records.pending()).some((record) => record.state !== "sending"))
      return (yield* Clock.currentTimeMillis) + 5000
  })
}
