import { Clock, Effect } from "effect"

import type { AgentId } from "../agents/domain"
import type { Submission } from "../conversations/turns"
import { ReplySendFailed as WhatsAppSendFailed } from "../replies/contracts"
import { deliverReply } from "../replies/delivery"
import { preserveFatal } from "../shared/effect"
import { taskCommand } from "../tasks/commands"
import type { WhatsAppStore } from "./adapters/sqlite"
import {
  whatsappIdentity,
  WhatsAppUnavailable,
  WHATSAPP_WINDOW_MS,
  type WhatsAppFailure,
  type WhatsAppRecord,
  type WhatsAppTurn,
} from "./contracts"
import { whatsappReply } from "./reply"

export { ReplySendFailed as WhatsAppSendFailed } from "../replies/contracts"
export interface WhatsAppPumpHost {
  control?: (
    body: string,
    agent: AgentId
  ) => Effect.Effect<string, WhatsAppFailure>
  media?: (record: WhatsAppRecord) => Effect.Effect<string, WhatsAppFailure>
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
    text: string,
    files: readonly string[] = []
  ) {
    const progress = record.delivery ?? {
      version: 1 as const,
      generation: (yield* records.settings()).generation,
      parts: whatsappReply(
        text,
        yield* host.name(record.agentId),
        host.reviewUrl(record.agentId),
        record.outboundFileId ? [record.outboundFileId] : files
      ),
      receipts: [],
    }
    yield* deliverReply(progress, {
      claim: (delivery, from) =>
        records.claim(
          record,
          text,
          () => host.active(record.agentId),
          delivery,
          from
        ),
      checkpoint: (delivery) =>
        records.update(record.id, "sending", "sending", { delivery }),
      send: (part) =>
        host.send(
          { ...record, outboundFileId: part.files[0] ?? null },
          part.text
        ),
      finish: (state, providerId) =>
        records.update(record.id, "sending", state, {
          providerId,
          error:
            state === "sent"
              ? null
              : state === "uncertain"
                ? "Delivery could not be confirmed. Check WhatsApp before retrying."
                : "This reply could not be sent. Review the connection, source file and reply window before retrying.",
        }),
    })
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
          media: null,
        },
        record.agentId,
        {
          reply:
            "An action needs your approval. Open Pi to review it. WhatsApp messages cannot approve actions.",
        }
      )
      .pipe(Effect.catchTag("WhatsAppRejected", () => Effect.void))
  })
  const prepareMedia = Effect.fn("WhatsApp.prepareMedia")(function* (
    record: WhatsAppRecord
  ) {
    let fileId = record.fileId
    if (record.media && !fileId) {
      if (!(yield* records.beginMedia(record.id))) return undefined
      const imported = yield* (
        host.media ? host.media(record) : Effect.fail(new WhatsAppUnavailable())
      ).pipe(
        Effect.map((id) => ({ id })),
        Effect.catchTag("WhatsAppRejected", (error) =>
          records
            .update(record.id, "queued", "failed", { error: error.message })
            .pipe(Effect.as(undefined))
        )
      )
      if (!imported) return undefined
      fileId = imported.id
      if (
        !(yield* records.update(record.id, "queued", "queued", {
          fileId,
        }))
      )
        return undefined
    }
    return fileId ? [fileId] : []
  })
  const prepareControl = Effect.fn("WhatsApp.prepareControl")(function* (
    record: WhatsAppRecord
  ) {
    if (!record.media && taskCommand(record.body)) {
      const reply = host.control
        ? yield* host.control(record.body, record.agentId)
        : "Task controls are unavailable. Open Pi to review the task."
      yield* records.update(record.id, "queued", "waiting", {
        reply,
        control: true,
      })
      return true
    }
    return false
  })
  const prepareQueued = Effect.fn("WhatsApp.prepareQueued")(function* (
    record: WhatsAppRecord
  ) {
    if (yield* prepareControl(record)) return
    const files = yield* prepareMedia(record)
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
    if (record.delivery || record.control) {
      yield* send(record, record.reply)
      return
    }
    if (record.state === "queued") {
      yield* prepareQueued(record)
      return
    }
    const turn = yield* host.turn(record.agentId, record.id)
    if (!turn) return
    if (turn.needsApproval) yield* notice(record)
    if (["done", "failed", "cancelled"].includes(turn.status)) {
      const answer = turn.answer.trim()
        ? turn.answer
        : turn.files?.length
          ? "Attachments included."
          : ""
      yield* send(
        record,
        turn.status === "done" && answer
          ? answer
          : turn.error ||
              "This request could not finish. Open Pi to review the conversation.",
        turn.status === "done" ? (turn.files ?? []) : []
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
