import { Clock, Effect } from "effect"

import type { Turn } from "../conversations/turns"
import type { Submission } from "../conversations/turns"
import { ReplySendFailed as EmailSendFailed } from "../replies/contracts"
import { deliverReply } from "../replies/delivery"
import { preserveFatal } from "../shared/effect"
import { taskCommand } from "../tasks/commands"
import { emailDecision } from "./approvals"
import {
  EmailUnavailable,
  type EmailRecord,
  type EmailFailure,
} from "./contracts"
import type { EmailPersistence } from "./persistence"
import { emailReply } from "./reply"

export { ReplySendFailed as EmailSendFailed } from "../replies/contracts"
export interface EmailPumpHost {
  control?: (record: EmailRecord) => Effect.Effect<string, EmailFailure>
  active: () => Effect.Effect<boolean, EmailFailure>
  admit: (input: Submission) => Effect.Effect<unknown, EmailUnavailable>
  turn: (id: string) => Effect.Effect<Turn | undefined, EmailFailure>
  send: (
    email: EmailRecord,
    reply: string,
    files?: readonly string[]
  ) => Effect.Effect<string, EmailSendFailed>
  reviewUrl: (record: EmailRecord) => Effect.Effect<string, EmailFailure>
  files?: (
    record: EmailRecord
  ) => Effect.Effect<readonly { id: string; size: number }[], EmailFailure>
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
    const progress = record.delivery ?? {
      version: 1 as const,
      generation: (yield* records.settings()).generation,
      parts: emailReply(
        text,
        yield* host.reviewUrl(record),
        host.files && includeFiles ? yield* host.files(record) : []
      ),
      receipts: [],
    }
    yield* deliverReply(progress, {
      claim: (delivery, from) =>
        records.claim(record.id, text, host.active, delivery, from),
      checkpoint: (delivery) =>
        records.update(record.id, "sending", "sending", { delivery }),
      send: (part) => host.send(record, part.text, part.files),
      finish: (state, providerId) =>
        records.update(record.id, "sending", state, {
          providerId,
          error:
            state === "sent"
              ? null
              : state === "uncertain"
                ? "Delivery could not be confirmed. Check your inbox before sending again."
                : "The email provider rejected this reply. Check email configuration before retrying.",
        }),
    })
  })
  const isTaskControl = (record: EmailRecord) =>
    !record.files?.length && taskCommand(record.body)
  const prepareControl = Effect.fn("Email.prepareControl")(function* (
    record: EmailRecord
  ) {
    if (isTaskControl(record)) {
      const reply = host.control
        ? yield* host.control(record)
        : "Task controls are unavailable. Open Pi to review the task."
      yield* records.update(record.id, "queued", "waiting", { reply })
      return true
    }
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
      return true
    }
    return false
  })
  const process = Effect.fn("Email.process")(function* (record: EmailRecord) {
    if (!(yield* records.settings()).enabled || !(yield* host.active())) {
      yield* records.update(record.id, record.state, "cancelled", {
        error:
          "Email is disabled or the agent is archived. The conversation remains in Pi.",
      })
      return
    }
    if (record.delivery) {
      yield* send(record, record.reply)
      return
    }
    if (record.state === "queued") {
      if (yield* prepareControl(record)) return
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
      if (
        record.purpose === "notification" ||
        emailDecision(record.body) ||
        (isTaskControl(record) && !!record.reply.trim())
      ) {
        yield* send(record, record.reply)
        return
      }
      const turn = yield* host.turn(record.id)
      if (turn && ["done", "failed", "cancelled"].includes(turn.status)) {
        const text =
          turn.status === "done"
            ? turn.answer || "Your request is complete."
            : turn.error ||
              `This request ${turn.status === "cancelled" ? "was cancelled" : "could not finish"}. Open Pi to review the conversation.`
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
