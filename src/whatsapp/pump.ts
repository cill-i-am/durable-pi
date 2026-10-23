import { Clock, Effect } from "effect"

import type { AgentId } from "../agents/domain"
import type { Submission } from "../conversations/turns"
import { admitReply } from "../replies/admission"
import {
  ReplySendFailed as WhatsAppSendFailed,
  type ReplyWork,
} from "../replies/contracts"
import { deliverReply } from "../replies/delivery"
import { prepareReply, type ReplyPreparation } from "../replies/preparation"
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
  armReply: (deadline: number) => Effect.Effect<void, WhatsAppFailure>
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
      arm: host.armReply,
      recover: (attemptId) => records.recoverAttempt(record.id, attemptId),
      claim: (delivery, from, lease) =>
        records.claim(
          record,
          text,
          () => host.active(record.agentId),
          delivery,
          from,
          lease
        ),
      checkpoint: (delivery, attemptId) =>
        records.checkpoint(record.id, attemptId, delivery),
      send: (part) =>
        host.send(
          { ...record, outboundFileId: part.files[0] ?? null },
          part.text
        ),
      finish: (state, providerId, attemptId) =>
        records.finish(
          record.id,
          attemptId,
          state,
          providerId,
          state === "sent"
            ? null
            : state === "uncertain"
              ? "Delivery could not be confirmed. Check WhatsApp before retrying."
              : "This reply could not be sent. Review the connection, source file and reply window before retrying."
        ),
    })
  })
  const notice = Effect.fn("WhatsApp.approvalNotice")(function* (
    record: WhatsAppRecord
  ) {
    const identity = yield* Effect.promise(() =>
      whatsappIdentity(`${record.id}:approval`)
    )
    yield* admitReply({
      arm: host.armReply,
      accept: (deadline) =>
        records.notice(
          record,
          {
            ...record,
            ...identity,
            messageId: `approval:${record.id}`,
            body: "Approval notification",
            media: null,
          },
          "An action needs your approval. Open Pi to review it. WhatsApp messages cannot approve actions.",
          deadline
        ),
      wake: Effect.void,
    }).pipe(
      preserveFatal,
      Effect.catchTag("WhatsAppRejected", () => Effect.void)
    )
  })
  const process = (record: WhatsAppRecord, work: ReplyWork) => {
    let revision = work.revision,
      progressed = false
    const control = !record.media && !!taskCommand(record.body)
    const kind: ReplyPreparation<WhatsAppFailure>["kind"] =
      record.delivery || record.control
        ? "deliver"
        : record.state === "queued"
          ? control
            ? "control"
            : record.media && !record.fileId
              ? "media"
              : "admit"
          : record.state === "waiting"
            ? "observe"
            : "skip"
    const draft = {
      text: record.reply,
      files: record.fileId ? [record.fileId] : [],
      includeFiles: false,
    }
    return prepareReply<WhatsAppFailure>({
      deadline: work.deadline,
      timeout: new WhatsAppUnavailable(),
      kind,
      draft,
      check: Effect.gen(function* () {
        const active = yield* host.active(record.agentId)
        const settings = yield* records.settings()
        if (
          !settings.enabled ||
          settings.generation !== record.generation ||
          !active
        )
          return "cancelled"
        return (yield* Clock.currentTimeMillis) - settings.lastInboundAt >=
          WHATSAPP_WINDOW_MS
          ? "expired"
          : "allowed"
      }),
      cancel: records.cancel(
        record.id,
        "WhatsApp is disabled or this agent is archived. The conversation remains in Pi."
      ),
      expire: records.expire(
        record.id,
        "The WhatsApp reply window closed. Review the conversation in Pi.",
        revision
      ),
      control: Effect.suspend(() =>
        host.control
          ? host.control(record.body, record.agentId)
          : Effect.succeed(
              "Task controls are unavailable. Open Pi to review the task."
            )
      ),
      media: {
        claim: records.beginMedia(record.id, revision).pipe(
          Effect.tap((ownedRevision) =>
            Effect.sync(() => {
              if (ownedRevision !== undefined) revision = ownedRevision
            })
          )
        ),
        import: Effect.suspend(() =>
          host.media
            ? host.media(record)
            : Effect.fail(new WhatsAppUnavailable())
        ).pipe(
          preserveFatal,
          Effect.map((fileId) => ({ fileId })),
          Effect.catchTag("WhatsAppRejected", (error) =>
            Effect.succeed({ rejected: error.message })
          )
        ),
        save: (ownedRevision, fileId) =>
          records.saveMedia(record.id, ownedRevision, fileId).pipe(
            Effect.tap((changed) =>
              Effect.sync(() => {
                if (changed) revision = ownedRevision + 1
              })
            )
          ),
        fail: (revision, error) =>
          records.preparationFailed(record.id, revision, error),
      },
      admit: (files) =>
        host.admit(record.agentId, {
          operationId: record.id,
          text: record.body,
          mode: "followUp",
          files,
          origin: {
            kind: "whatsapp",
            sender: record.sender,
            messageId: record.messageId,
          },
        }),
      prepared: (reply, isControl) =>
        records.prepared(record.id, reply, isControl, revision).pipe(
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
        const turn = yield* host.turn(record.agentId, record.id)
        progressed = true
        const ready =
          !!turn && ["done", "failed", "cancelled"].includes(turn.status)
        const answer = !turn
          ? ""
          : turn.answer.trim()
            ? turn.answer
            : turn.files?.length
              ? "Attachments included."
              : ""
        return {
          ready,
          notify: !!turn?.needsApproval,
          draft: {
            text: !ready
              ? ""
              : turn.status === "done" && answer
                ? answer
                : turn.error ||
                  "This request could not finish. Open Pi to review the conversation.",
            files: ready && turn.status === "done" ? (turn.files ?? []) : [],
            includeFiles: false,
          },
        }
      }),
      notify: notice(record),
      deliver: (reply) => send(record, reply.text, reply.files),
    }).pipe(Effect.map(() => (progressed ? revision : undefined)))
  }
  return Effect.fn("WhatsApp.pump")(function* () {
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
