import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Effect, Equal, Exit, Ref, Schema } from "effect"

import type { ConfigurationLedger } from "../agents/configuration"
import { AgentConflict, AgentStorageError } from "../agents/domain"
import {
  ModelUnavailable,
  pinnedRoute,
  resolveRoute,
  validateRoute,
  type ModelCatalog,
  type ResolvedRoute,
} from "../inference/policy"
import { SkillConflict, SkillStorageError } from "../skills/contracts"
import type { SkillLedger } from "../skills/repository"
import type { WorkspaceAdmission } from "../workspace/admission"
import { prepareAttachments } from "../workspace/attachments"
import {
  FileNotFound,
  FileRejected,
  WorkspaceReadOnly,
  WorkspaceUnavailable,
} from "../workspace/files"
import type { Workspace } from "../workspace/workspace"
import { conversationAdmissionMachine } from "./admission.machine"
import type { ConversationMaterialization } from "./journal"
import type { ConversationLedger } from "./ledger"
import type { Conversations } from "./service"
import {
  ConversationConflict,
  conversationFailure,
  type Submission,
  type PreparedMessage,
  type Turn,
  type TurnAdmission,
} from "./turns"

export class ConversationRejected extends Schema.TaggedError<ConversationRejected>()(
  "ConversationRejected",
  {
    reason: Schema.Literals(["empty", "disconnected", "archived"]),
  }
) {}
export type SubmissionReceipt = {
  accepted: boolean
  operationId: string
  replyId: string
}
const receipt = ({ turn, accepted }: TurnAdmission): SubmissionReceipt => ({
  accepted,
  operationId: turn.id,
  replyId: turn.parent_id ?? turn.id,
})
export const submissionParent = (input: Submission, active: Turn | undefined) =>
  input.mode === "steer" && active?.status !== "stopping" ? active : undefined
const attempt = <T>(body: () => T) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const failure = conversationFailure(cause)
      if (failure) return failure
      const knownFailure = Schema.decodeUnknownOption(
        Schema.Union([
          ConversationRejected,
          AgentConflict,
          AgentStorageError,
          SkillConflict,
          SkillStorageError,
          FileNotFound,
          FileRejected,
          WorkspaceReadOnly,
          WorkspaceUnavailable,
          ModelUnavailable,
        ])
      )(cause)
      if (knownFailure._tag === "Some") return knownFailure.value
      throw cause
    },
  })

/** Final replay, archive, file and parent checks execute with admission, not in
 * a separate runtime or across an asynchronous preparation boundary. */
export function guardedMessageAdmission(
  conversations: ConversationLedger,
  configuration: ConfigurationLedger,
  files: typeof WorkspaceAdmission.Service,
  skills: SkillLedger,
  storage: Pick<ConversationMaterialization, "transactionGroup" | "atomic">
) {
  return Effect.fn("Conversations.commitMessage")(function* (
    input: Submission,
    prepared: PreparedMessage,
    route: ResolvedRoute,
    parentId: string | null,
    catalog: ModelCatalog,
    discoveryDeadline: number
  ) {
    yield* attempt(() => {
      if (
        [
          conversations.transactionGroup,
          configuration.transactionGroup,
          files.transactionGroup,
          skills.transactionGroup,
        ].some((group) => group !== storage.transactionGroup)
      )
        throw new ConversationConflict({
          message:
            "Message capabilities must share their native transaction group.",
        })
    })
    return yield* storage.atomic(() =>
      Effect.gen(function* () {
        if (yield* conversations.get(input.operationId))
          return yield* conversations.admit(input)
        if ((yield* configuration.read())?.status === "archived")
          return yield* new ConversationRejected({ reason: "archived" })
        yield* files.requireFiles(input.files ?? [])
        if (
          (submissionParent(input, yield* conversations.active())?.id ??
            null) !== parentId
        )
          return yield* new ConversationConflict({
            message:
              "The active reply changed. Retry to send with the current run settings.",
          })
        const capability = yield* attempt(() =>
          validateRoute(
            route,
            catalog,
            prepared.content.some((block) => block.type === "image") ||
              (!!prepared.pending &&
                prepared.files.some(
                  (file) => file.kind === "video" || file.kind === "image"
                ))
          )
        )
        return yield* conversations.admit(
          input,
          prepared,
          (yield* skills.selection()).skills,
          {
            ...route,
            contextWindow: Math.min(
              route.contextWindow ?? capability.contextWindow,
              capability.contextWindow
            ),
          },
          { discoveryDeadline }
        )
      })
    )
  })
}
export type MessageCommit = ReturnType<typeof guardedMessageAdmission>
export interface MessageAdmissionHost<TError, TRequirements = never> {
  connected: () => Effect.Effect<boolean, TError, TRequirements>
  archived: () => Effect.Effect<boolean, TError, TRequirements>
  catalog: () => Effect.Effect<ModelCatalog, TError, TRequirements>
  prearm: () => Effect.Effect<number, TError, TRequirements>
  wake: () => Effect.Effect<void, TError, TRequirements>
  notify: () => Effect.Effect<void, TError, TRequirements>
}
export function messageAdmission<TError, TRequirements>(
  conversations: typeof Conversations.Service,
  workspace: Pick<
    typeof Workspace.Service,
    "attach" | "requireFiles" | "retryExtraction"
  >,
  commit: MessageCommit,
  host: MessageAdmissionHost<TError, TRequirements>
) {
  return Effect.fn("Conversations.acceptMessage")(function* (
    input: Submission
  ) {
    if (!input.text.trim() && !input.files?.length)
      return yield* new ConversationRejected({ reason: "empty" })
    const prepare = Effect.gen(function* () {
      if (!(yield* host.connected()))
        return yield* new ConversationRejected({ reason: "disconnected" })
      const prepared = yield* prepareAttachments(
        workspace,
        input.files ?? [],
        !!input.retryOf
      )
      if (yield* host.archived())
        return yield* new ConversationRejected({ reason: "archived" })
      yield* workspace.requireFiles(input.files ?? [])
      const parent = submissionParent(input, yield* conversations.active())
      const retry = input.retryOf
        ? yield* conversations.get(input.retryOf)
        : undefined
      const settings = yield* conversations.settings()
      const job = input.job ?? "conversation"
      const route =
        pinnedRoute(parent, settings) ??
        pinnedRoute(retry, settings) ??
        resolveRoute(job, yield* conversations.jobSetting(job), input.profile)
      const catalog = yield* host.catalog()
      return { prepared, route, parentId: parent?.id ?? null, catalog }
    })
    type Failure =
      | Effect.Error<typeof prepare>
      | Effect.Error<ReturnType<MessageCommit>>
    const failed = yield* Ref.make<Cause.Cause<Failure> | undefined>(undefined)
    const observe = <A>(effect: Effect.Effect<A, Failure, TRequirements>) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? Ref.set(failed, exit.cause) : Effect.void
        )
      )
    return yield* Effect.gen(function* () {
      const actor = yield* createEffectActor(
        conversationAdmissionMachine({
          replaying: observe(
            conversations.get(input.operationId).pipe(Effect.map(Boolean))
          ),
          prepare: observe(prepare),
          validate: ({ prepared, route, catalog }) =>
            observe(
              attempt(() =>
                validateRoute(
                  route,
                  catalog,
                  prepared.content.some((block) => block.type === "image") ||
                    (!!prepared.pending &&
                      prepared.files.some(
                        (file) => file.kind === "video" || file.kind === "image"
                      ))
                )
              ).pipe(Effect.asVoid)
            ),
          arm: observe(Effect.suspend(host.prearm)),
          accept: ({ prepared, route, parentId, catalog }, deadline) =>
            observe(
              Effect.gen(function* () {
                const admitted = yield* commit(
                  input,
                  prepared,
                  route,
                  parentId,
                  catalog,
                  deadline
                )
                yield* host.wake()
                yield* host.notify()
                return receipt(admitted)
              })
            ),
          replay: observe(
            Effect.gen(function* () {
              const replay = yield* conversations.admit(input)
              // Exact replay can wake existing work, but cannot renew an exhausted
              // discovery lease or authorize another native submission.
              yield* host.wake()
              return receipt(replay)
            })
          ),
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
      )
    )
  })
}
