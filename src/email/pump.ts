import { Clock, Effect, Schema } from "effect"

import type { Turn } from "../conversations/turns"
import type { Submission } from "../conversations/turns"
import { preserveFatal } from "../shared/effect"
import { emailDecision } from "./approvals"
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
    reply: string,
    attachments?: EmailAttachment[]
  ) => Effect.Effect<string, EmailSendFailed>
  reviewUrl: (record: EmailRecord) => Effect.Effect<string, EmailFailure>
  files?: (
    record: EmailRecord,
    reviewUrl: string
  ) => Effect.Effect<
    { attachments: EmailAttachment[]; suffix: string },
    EmailFailure
  >
  notices?: (
    record: EmailRecord
  ) => Effect.Effect<readonly { key: string; text: string }[], EmailFailure>
  decide?: (record: EmailRecord) => Effect.Effect<string, EmailFailure>
}
export function emailPump(records: EmailPersistence, host: EmailPumpHost) {
  const send = Effect.fn("Email.sendReply")(function* (
    record: EmailRecord,
    text: string,
    includeFiles = false
  ) {
    const reviewUrl = yield* host.reviewUrl(record)
    const files =
      host.files && includeFiles
        ? yield* host.files(record, reviewUrl)
        : { attachments: [], suffix: "" }
    const reply = `${text.replace(/\n\nView this agent in Pi: https?:\/\/[^\s]+$/, "")}${files.suffix}\n\nView this agent in Pi: ${reviewUrl}`
    if (!(yield* records.claim(record.id, reply, host.active))) return
    // Persist the claim before contacting the provider. An interrupted claim is
    // recovered as uncertain; neither a restart nor a webhook replay resends it.
    yield* host.send(record, reply, files.attachments).pipe(
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
      if (emailDecision(record.body)) {
        const reply = yield* (
          host.decide
            ? host.decide(record)
            : Effect.succeed(
                "Email decisions are unavailable. Review this action in Pi."
              )
        ).pipe(
          Effect.catchTag("EmailRejected", (error) =>
            Effect.succeed(error.message)
          )
        )
        yield* records.update(record.id, "queued", "waiting", { reply })
        return
      }
      yield* host.admit({
        operationId: record.id,
        text: `Subject: ${record.subject || "(no subject)"}\n\n${record.body}`,
        origin: {
          kind: "email",
          sender: record.sender,
          subject: record.subject,
        },
        mode: "followUp",
        files: record.files,
      })
      yield* records.update(record.id, "queued", "waiting")
    }
    if (record.state === "waiting") {
      if (record.purpose === "notification" || emailDecision(record.body)) {
        yield* send(record, record.reply)
        return
      }
      const turn = yield* host.turn(record.id)
      if (turn && ["done", "failed", "cancelled"].includes(turn.status)) {
        const text =
          turn.status === "done" && turn.answer.trim()
            ? turn.answer
            : `This request ${turn.status === "cancelled" ? "was cancelled" : "could not finish"}. Open Pi to review the conversation.`
        yield* send(record, text, turn.status === "done")
      } else if (host.notices) {
        for (const notice of yield* host.notices(record))
          yield* records.notice(record, notice.key, notice.text)
      }
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
