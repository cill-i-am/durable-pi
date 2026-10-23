import { Clock, Effect } from "effect"

import type { Turn } from "../conversations/turns"
import type { Submission } from "../conversations/turns"
import { admitReply } from "../replies/admission"
import {
  ReplySendFailed as EmailSendFailed,
  type ReplyWork,
} from "../replies/contracts"
import { deliverReply } from "../replies/delivery"
import { prepareReply, type ReplyPreparation } from "../replies/preparation"
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
  armReply: (deadline: number) => Effect.Effect<void, EmailFailure>
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
      arm: host.armReply,
      recover: (attemptId) => records.recoverAttempt(record.id, attemptId),
      claim: (delivery, from, lease) =>
        records.claim(record.id, text, host.active, delivery, from, lease),
      checkpoint: (delivery, attemptId) =>
        records.checkpoint(record.id, attemptId, delivery),
      send: (part) => host.send(record, part.text, part.files),
      finish: (state, providerId, attemptId) =>
        records.finish(
          record.id,
          attemptId,
          state,
          providerId,
          state === "sent"
            ? null
            : state === "uncertain"
              ? "Delivery could not be confirmed. Check your inbox before sending again."
              : "The email provider rejected this reply. Check email configuration before retrying."
        ),
    })
  })
  const isTaskControl = (record: EmailRecord) =>
    !record.files?.length && taskCommand(record.body)
  const process = (record: EmailRecord, work: ReplyWork) => {
    let revision = work.revision,
      progressed = false
    const taskControl = !!isTaskControl(record)
    const decision = !!emailDecision(record.body)
    const kind: ReplyPreparation<EmailFailure>["kind"] = record.delivery
      ? "deliver"
      : record.state === "queued"
        ? taskControl || decision
          ? "control"
          : "admit"
        : record.state === "waiting"
          ? record.purpose === "notification" ||
            decision ||
            (taskControl && !!record.reply.trim())
            ? "deliver"
            : "observe"
          : "skip"
    const draft = {
      text: record.reply,
      files: record.files ?? [],
      includeFiles: false,
    }
    return prepareReply<EmailFailure>({
      deadline: work.deadline,
      timeout: new EmailUnavailable(),
      kind,
      draft,
      check: Effect.gen(function* () {
        return (yield* records.settings()).enabled && (yield* host.active())
          ? "allowed"
          : "cancelled"
      }),
      cancel: records.cancel(
        record.id,
        "Email is disabled or the agent is archived. The conversation remains in Pi."
      ),
      control: Effect.suspend(() =>
        taskControl
          ? host.control
            ? host.control(record)
            : Effect.succeed(
                "Task controls are unavailable. Open Pi to review the task."
              )
          : (host.decide
              ? host.decide(record)
              : Effect.succeed(
                  "Email decisions are unavailable. Review this action in Pi."
                )
            ).pipe(
              preserveFatal,
              Effect.catchTag("EmailRejected", (error) =>
                Effect.succeed(error.message)
              )
            )
      ),
      admit: (files) =>
        host.admit({
          operationId: record.id,
          text: `Subject: ${record.subject || "(no subject)"}\n\n${record.body}`,
          origin: {
            kind: "email",
            sender: record.sender,
            subject: record.subject,
          },
          mode: "followUp",
          files,
        }),
      prepared: (reply) =>
        records.prepared(record.id, reply, revision).pipe(
          Effect.tap((changed) =>
            Effect.sync(() => {
              if (changed) {
                revision++
                progressed = true
              }
            })
          )
        ),
      observe: Effect.gen(function* () {
        const turn = yield* host.turn(record.id)
        progressed = true
        const ready =
          !!turn && ["done", "failed", "cancelled"].includes(turn.status)
        return {
          ready,
          notify: !ready && !!host.notices,
          draft: {
            text: !ready
              ? ""
              : turn.status === "done"
                ? turn.answer || "Your request is complete."
                : turn.error ||
                  `This request ${turn.status === "cancelled" ? "was cancelled" : "could not finish"}. Open Pi to review the conversation.`,
            files: [],
            includeFiles: ready && turn.status === "done",
          },
        }
      }),
      notify: Effect.gen(function* () {
        for (const notice of host.notices ? yield* host.notices(record) : [])
          yield* admitReply({
            arm: host.armReply,
            accept: (deadline) =>
              records.notice(record, notice.key, notice.text, deadline),
            wake: Effect.void,
          })
      }),
      deliver: (reply) => send(record, reply.text, reply.includeFiles),
    }).pipe(Effect.map(() => (progressed ? revision : undefined)))
  }
  return Effect.fn("Email.pump")(function* () {
    yield* records.recover(false)
    for (const record of yield* records.pending()) {
      if (record.state === "sending") continue
      const work = yield* records.getPendingWork(record.id)
      if (!work) continue
      const revision = yield* process(work.record, work).pipe(preserveFatal)
      if (
        revision === undefined ||
        (yield* records.getPendingWork(record.id))?.revision !== revision
      )
        continue
      yield* admitReply({
        arm: host.armReply,
        accept: (deadline) => records.renewWork(record.id, revision, deadline),
        wake: Effect.void,
      }).pipe(preserveFatal)
    }
    if ((yield* records.pending()).some((record) => record.state !== "sending"))
      return Math.min(
        (yield* Clock.currentTimeMillis) + 5000,
        (yield* records.nextRecovery()) ?? Infinity
      )
    return yield* records.nextRecovery()
  })
}
