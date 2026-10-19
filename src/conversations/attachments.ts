import { Effect } from "effect"

import type { ConfigurationLedger } from "../agents/configuration"
import type { WorkspaceAdmission } from "../workspace/admission"
import { prepareAttachments } from "../workspace/attachments"
import { FileRejected } from "../workspace/files"
import type { Workspace } from "../workspace/workspace"
import type { ConversationMaterialization } from "./journal"
import type { ConversationLedger } from "./ledger"
import type { Turn } from "./turns"

export type AttachmentReadiness = { ready: boolean; error?: string }

/** Materialize input once, after asynchronous preparation. The last authority,
 * file and cancellation checks share the original admission transaction. */
export function resumeAttachments(
  conversations: ConversationLedger,
  workspace: typeof Workspace.Service,
  configuration: ConfigurationLedger,
  files: typeof WorkspaceAdmission.Service,
  storage: Pick<ConversationMaterialization, "transactionGroup" | "atomic">
) {
  return Effect.fn("Conversations.resumeAttachments")(function* (turn: Turn) {
    if (!turn.files_pending) return { ready: true }
    return yield* Effect.gen(function* () {
      const prepared = yield* prepareAttachments(
        workspace,
        turn.attachments.map((f) => f.id)
      )
      if (prepared.pending && !prepared.error) return { ready: false }
      if (
        conversations.transactionGroup !== storage.transactionGroup ||
        files.transactionGroup !== storage.transactionGroup ||
        configuration.transactionGroup !== storage.transactionGroup
      )
        return yield* Effect.die(
          new Error(
            "Attachment preparation must share admission's transaction group"
          )
        )
      return yield* storage.atomic(() =>
        Effect.gen(function* () {
          const current = yield* conversations.get(turn.id)
          if (
            !current?.files_pending ||
            !["queued", "preparing"].includes(current.status)
          )
            return { ready: false }
          if ((yield* configuration.read())?.status === "archived")
            return yield* new FileRejected({
              message:
                "The agent was archived while its files were being prepared.",
            })
          yield* files.requireFiles(turn.attachments.map((f) => f.id))
          const saved = yield* conversations.saveAttachments(turn.id, prepared)
          return prepared.error && saved
            ? { ready: false, error: prepared.error }
            : { ready: saved }
        })
      )
    }).pipe(
      Effect.catchTags({
        FileRejected: (error) =>
          Effect.succeed({ ready: false, error: error.message }),
        FileNotFound: () =>
          Effect.succeed({
            ready: false,
            error:
              "An attached file was removed or is no longer available. Restore it or send a different file.",
          }),
        WorkspaceReadOnly: () =>
          Effect.succeed({
            ready: false,
            error: "File preparation paused because this agent is archived.",
          }),
      })
    )
  })
}
