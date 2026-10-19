import {
  pinnedRoute,
  resolveRoute,
  type ResolvedRoute,
} from "../inference/policy"
import { skillContext, type SkillDocument } from "../skills/contracts"
import type { TurnOrigin } from "./contracts"
import {
  ConversationConflict,
  ConversationFull,
  isPending,
  type ModelSettings,
  type Submission,
  type Turn,
  type PreparedMessage,
  type TurnOutcome,
} from "./turns"

export function submissionIdentity(
  input: Submission,
  origin: TurnOrigin | undefined
): string {
  return JSON.stringify({
    ...(origin ? { origin } : {}),
    text: input.text,
    mode: input.mode ?? "followUp",
    retryOf: input.retryOf ?? null,
    ...(input.profile && input.profile !== "auto"
      ? { profile: input.profile }
      : {}),
    ...(input.job && input.job !== "conversation" ? { job: input.job } : {}),
    ...(input.files?.length ? { files: input.files } : {}),
  })
}
export function requireReplay(
  existing: Turn,
  input: Submission,
  creation: string
) {
  if (
    existing.creation
      ? existing.creation !== creation
      : existing.text !== input.text ||
        (input.mode ?? "followUp") !== "followUp"
  )
    throw new ConversationConflict({
      message: "That operation ID belongs to another message.",
    })
}
export function requireCapacity(pending: number) {
  if (pending >= 10) throw new ConversationFull()
}
export function requireRetry(input: Submission, source: Turn | undefined) {
  if (
    input.retryOf &&
    (!source || !["failed", "cancelled"].includes(source.status))
  )
    throw new ConversationConflict({
      message: "Only an interrupted reply can be retried.",
    })
}
export function admissionParent(
  input: Submission,
  active: Turn | undefined
): Turn | undefined {
  if (input.mode === "steer" && active?.status === "stopping")
    throw new ConversationConflict({
      message:
        "This reply is stopping. Send your message again after it stops.",
    })
  return input.mode === "steer" ? active : undefined
}
export function requireSteer(
  parent: Turn | undefined,
  input: Submission,
  attachmentCount: number
) {
  if (parent && attachmentCount > 4)
    throw new ConversationConflict({
      message:
        "This reply already has its four-file allowance. Queue the files in a new message.",
    })
  if (parent && input.profile && input.profile !== "auto")
    throw new ConversationConflict({
      message:
        "Steering keeps the active run's model. Queue a new message to use an override.",
    })
}
export function admissionRoute(
  input: Submission,
  facts: {
    parent?: Turn
    source?: Turn
    resolved?: ResolvedRoute
    defaults: ModelSettings
    jobSetting?: ModelSettings
  }
): ResolvedRoute {
  if (facts.parent)
    return {
      ...pinnedRoute(facts.parent, facts.defaults)!,
      reason: "active run",
    }
  return (
    pinnedRoute(facts.source, facts.defaults) ??
    facts.resolved ??
    resolveRoute(
      input.job ?? "conversation",
      facts.jobSetting ??
        ((input.job ?? "conversation") === "conversation"
          ? facts.defaults
          : undefined),
      input.profile
    )
  )
}
export function admissionContent(
  parent: Turn | undefined,
  skills: readonly SkillDocument[],
  prepared?: PreparedMessage
) {
  return {
    files_pending: prepared?.pending ?? false,
    attachments: prepared?.files ?? [],
    input: prepared?.content ?? [],
    skills:
      parent?.skills ??
      skills.map(({ id, name, revision }) => ({ id, name, revision })),
    skill_context: parent ? "" : skillContext(skills),
  }
}
export function stopTransition(turn: Turn | undefined, root: Turn | undefined) {
  if (!turn || !isPending(turn)) return
  if (!root) throw new Error("A pending conversation member has no root turn")
  return { rootId: root.id, change: isPending(root) }
}
export const stopRoot = (turn: Turn | undefined) =>
  turn && isPending(turn) ? (turn.parent_id ?? turn.id) : undefined
export const submittedDelivery = (turn: Turn) =>
  turn.delivery === "queued" ? "accepted" : turn.delivery
export function finishTransition(
  root: Turn,
  current: Turn,
  members: readonly Turn[],
  outcomes: readonly TurnOutcome[],
  answer: string,
  error: string | null
) {
  if (current.revision !== root.revision || !isPending(current)) return
  if (
    members.length !== outcomes.length ||
    members.some(
      (member) => !outcomes.some((outcome) => outcome.id === member.id)
    )
  )
    return
  const stopped = current.status === "stopping"
  return {
    members: outcomes.map(
      (outcome): TurnOutcome & { status: Turn["status"] } => ({
        ...outcome,
        status:
          outcome.id === root.id && stopped
            ? "cancelled"
            : outcome.delivery === "answered"
              ? "done"
              : stopped
                ? "cancelled"
                : "failed",
      })
    ),
    answer,
    error: stopped ? null : error,
  }
}
export const canPrepare = (turn: Turn) => turn.status === "queued"
export const canSavePrompt = (turn: Turn) => turn.prompt === null
export const canSaveSession = (turn: Turn) => turn.session_id === null
export const canSubmit = (turn: Turn) =>
  !turn.files_pending &&
  ["queued", "preparing", "running"].includes(turn.status)
export const canConsume = (turn: Turn) =>
  ["queued", "accepted"].includes(turn.delivery)
