import { Clock, Effect, Schema } from "effect"

import type { AgentId } from "../agents/domain"
import type { Submission } from "../conversations/turns"
import { preserveFatal } from "../shared/effect"
import type { WhatsAppStore } from "./adapters/sqlite"
import {
  whatsappIdentity,
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
    const reply =
      `${name}\n\n${text.slice(0, 3000)}${text.length > 3000 ? "\n\nContinued in Pi." : ""}\n\n${host.reviewUrl(record.agentId)}`.slice(
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
              : "WhatsApp rejected this reply. Review the connection and reply window before retrying.",
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
        },
        record.agentId,
        "An action needs your approval. Open Pi to review it. WhatsApp messages cannot approve actions."
      )
      .pipe(Effect.catchTag("WhatsAppRejected", () => Effect.void))
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
      yield* host.admit(record.agentId, {
        operationId: record.id,
        text: record.body,
        mode: "followUp",
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
    if (["done", "failed", "cancelled"].includes(turn.status))
      yield* send(
        record,
        turn.status === "done" && turn.answer.trim()
          ? turn.answer
          : "This request could not finish. Open Pi to review the conversation."
      )
  })
  return Effect.fn("WhatsApp.pump")(function* () {
    for (const record of yield* records.pending()) {
      if (record.state === "sending") continue
      yield* process(record).pipe(
        preserveFatal,
        Effect.catchTag("WhatsAppUnavailable", () => Effect.void)
      )
    }
    if ((yield* records.pending()).some((record) => record.state !== "sending"))
      return (yield* Clock.currentTimeMillis) + 5000
  })
}
