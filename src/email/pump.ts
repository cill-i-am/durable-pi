import { Clock, Effect, Schema } from "effect"

import type { Turn } from "../conversations/turns"
import type { Submission } from "../conversations/turns"
import { preserveFatal } from "../shared/effect"
import {
  EmailUnavailable,
  type EmailRecord,
  type EmailFailure,
} from "./contracts"
import type { EmailPersistence } from "./persistence"

export class EmailSendFailed extends Schema.TaggedError<EmailSendFailed>()(
  "EmailSendFailed",
  {
    uncertain: Schema.Boolean,
  }
) {}
export interface EmailPumpHost {
  active: () => Effect.Effect<boolean, EmailFailure>
  admit: (input: Submission) => Effect.Effect<unknown, EmailUnavailable>
  turn: (id: string) => Effect.Effect<Turn | undefined, EmailFailure>
  send: (
    email: EmailRecord,
    reply: string
  ) => Effect.Effect<string, EmailSendFailed>
  reviewUrl: string
}
export function emailPump(records: EmailPersistence, host: EmailPumpHost) {
  const send = Effect.fn("Email.sendReply")(function* (
    record: EmailRecord,
    turn: Turn
  ) {
    const text =
      turn.status === "done" && turn.answer.trim()
        ? turn.answer
        : `This request ${turn.status === "cancelled" ? "was cancelled" : "could not finish"}. Open Pi to review the conversation.`
    const reply = `${text}\n\nView this agent in Pi: ${host.reviewUrl}`
    if (!(yield* records.claim(record.id, reply, host.active))) return
    // Persist the claim before contacting the provider. An interrupted claim is
    // recovered as uncertain; neither a restart nor a webhook replay resends it.
    yield* host.send(record, reply).pipe(
      preserveFatal,
      Effect.flatMap((providerId) =>
        records.update(record.id, "sending", "sent", { providerId })
      ),
      Effect.catchTag("EmailSendFailed", (error) =>
        records.update(
          record.id,
          "sending",
          error.uncertain ? "uncertain" : "failed",
          {
            error: error.uncertain
              ? "Delivery could not be confirmed. Check your inbox before sending again."
              : "The email provider rejected this reply. Check email configuration before retrying.",
          }
        )
      )
    )
  })
  const process = Effect.fn("Email.process")(function* (record: EmailRecord) {
    if (!(yield* records.settings()).enabled || !(yield* host.active())) {
      yield* records.update(record.id, record.state, "cancelled", {
        error:
          "Email is disabled or the agent is archived. The conversation remains in Pi.",
      })
      return
    }
    if (record.state === "queued") {
      yield* host.admit({
        operationId: record.id,
        text: `Subject: ${record.subject || "(no subject)"}\n\n${record.body}`,
        origin: {
          kind: "email",
          sender: record.sender,
          subject: record.subject,
        },
        mode: "followUp",
      })
      yield* records.update(record.id, "queued", "waiting")
    }
    if (record.state === "waiting") {
      const turn = yield* host.turn(record.id)
      if (turn && ["done", "failed", "cancelled"].includes(turn.status))
        yield* send(record, turn)
    }
  })
  return Effect.fn("Email.pump")(function* () {
    for (const record of yield* records.pending()) {
      if (record.state === "sending") continue
      yield* process(record).pipe(
        preserveFatal,
        Effect.catchTag("EmailUnavailable", () => Effect.void)
      )
    }
    if ((yield* records.pending()).some((record) => record.state !== "sending"))
      return (yield* Clock.currentTimeMillis) + 5000
  })
}
