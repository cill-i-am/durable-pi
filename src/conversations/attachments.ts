import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Effect, Equal, Exit, Ref } from "effect"

import type { ConfigurationLedger } from "../agents/configuration"
import { preserveFatal } from "../shared/effect"
import type { WorkspaceAdmission } from "../workspace/admission"
import { prepareAttachments } from "../workspace/attachments"
import { FileRejected } from "../workspace/files"
import type { Workspace } from "../workspace/workspace"
import { conversationAttachmentsMachine } from "./attachments.machine"
import type { ConversationMaterialization } from "./journal"
import type { ConversationLedger } from "./ledger"
import type { PreparedMessage, Turn } from "./turns"

export type PreparedAttachments = PreparedMessage & { error?: string }
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
  return Effect.fn("Conversations.resumeAttachments")(function* (
    turn: Turn,
    owner?: string
  ) {
    if (!turn.files_pending) return { ready: true }
    const prepare = prepareAttachments(
      workspace,
      turn.attachments.map((f) => f.id)
    )
    const commit = (prepared: PreparedAttachments) =>
      Effect.gen(function* () {
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
            const saved = yield* conversations.saveAttachments(
              turn.id,
              prepared,
              owner
            )
            return prepared.error && saved
              ? { ready: false, error: prepared.error }
              : { ready: saved }
          })
        )
      })
    type Failure =
      | Effect.Error<typeof prepare>
      | Effect.Error<ReturnType<typeof commit>>
    const failed = yield* Ref.make<Cause.Cause<Failure> | undefined>(undefined)
    const observe = <A>(effect: Effect.Effect<A, Failure>) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? Ref.set(failed, exit.cause) : Effect.void
        )
      )
    return yield* Effect.gen(function* () {
      const actor = yield* createEffectActor(
        conversationAttachmentsMachine({
          prepare: observe(prepare),
          commit: (prepared) => observe(commit(prepared)),
        })
      )
      const done = yield* waitFor(
        actor,
        (state) => state.status === "done"
      ).pipe(Effect.orDie)
      return yield* done.output!
    }).pipe(
      Effect.scoped,
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          if (!Exit.isFailure(exit) || !Cause.hasInterrupts(exit.cause)) return
          const failure = yield* Ref.get(failed)
          const reasons =
            failure?.reasons.filter(
              (reason) =>
                reason._tag !== "Interrupt" &&
                !exit.cause.reasons.some((present) =>
                  Equal.equals(present, reason)
                )
            ) ?? []
          if (reasons.length)
            return yield* Effect.failCause(Cause.fromReasons(reasons))
        })
      ),
      preserveFatal,
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
