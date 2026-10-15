import { Schema, Context, Effect, Layer } from "effect"
import type { JobType, ResolvedRoute } from "../inference/policy"
import type { SkillDocument } from "../skills/contracts"
import type { ConversationLedger } from "./ledger"
import {
  ConversationConflict,
  ConversationFull,
  ConversationStorageError,
  type ModelSettings,
  type PreparedMessage,
  type Submission,
  type Turn,
  type TurnOutcome,
} from "./turns"

export type ConversationError =
  ConversationConflict | ConversationFull | ConversationStorageError
type EffectOperations<T> = {
  [TKey in keyof T]: T[TKey] extends (...args: infer TArgs) => infer TReturn
    ? (...args: TArgs) => Effect.Effect<TReturn, ConversationError>
    : never
}
export type ConversationOperations = EffectOperations<
  Omit<ConversationLedger, "transactionGroup">
>
export class Conversations extends Context.Service<
  Conversations,
  ConversationOperations
>()("durable-pi/conversations/Conversations") {}

const attempt = <T>(body: () => T) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const knownFailure = Schema.decodeUnknownOption(
        Schema.Union([
          ConversationConflict,
          ConversationFull,
          ConversationStorageError,
        ])
      )(cause)
      if (knownFailure._tag === "Some") return knownFailure.value
      throw cause
    },
  })
const call = <TArgs extends readonly unknown[], TReturn>(
  name: string,
  body: (...args: TArgs) => TReturn
) => Effect.fn(name)((...args: TArgs) => attempt(() => body(...args)))

/** Application callers compose Effects; native Pi admission callbacks retain
 * the synchronous ledger so their transaction never crosses a runtime. */
export const makeConversations = (
  ledger: ConversationLedger
): ConversationOperations => ({
  jobSetting: call("Conversations.jobSetting", (job: JobType) =>
    ledger.jobSetting(job)
  ),
  setJobSetting: call(
    "Conversations.setJobSetting",
    (job: JobType, settings: ModelSettings) =>
      ledger.setJobSetting(job, settings)
  ),
  settings: call("Conversations.settings", () => ledger.settings()),
  setSettings: call("Conversations.setSettings", (settings: ModelSettings) =>
    ledger.setSettings(settings)
  ),
  selection: call("Conversations.selection", () => ledger.selection()),
  get: call("Conversations.get", (id: string) => ledger.get(id)),
  active: call("Conversations.active", () => ledger.active()),
  recent: call("Conversations.recent", () => ledger.recent()),
  statusTurns: call("Conversations.statusTurns", () => ledger.statusTurns()),
  members: call("Conversations.members", (id: string, includeInput?: boolean) =>
    ledger.members(id, includeInput)
  ),
  admit: call(
    "Conversations.admit",
    (
      input: Submission,
      prepared?: PreparedMessage,
      skills?: readonly SkillDocument[],
      resolved?: ResolvedRoute
    ) => ledger.admit(input, prepared, skills, resolved)
  ),
  prepare: call("Conversations.prepare", (id: string) => ledger.prepare(id)),
  savePrompt: call("Conversations.savePrompt", (id: string, prompt: string) =>
    ledger.savePrompt(id, prompt)
  ),
  saveSession: call(
    "Conversations.saveSession",
    (id: string, session: string) => ledger.saveSession(id, session)
  ),
  submitted: call("Conversations.submitted", (id: string, session: string) =>
    ledger.submitted(id, session)
  ),
  consumed: call("Conversations.consumed", (id: string) => ledger.consumed(id)),
  requestStop: call("Conversations.requestStop", (id: string) =>
    ledger.requestStop(id)
  ),
  finish: call(
    "Conversations.finish",
    (
      root: Turn,
      outcomes: readonly TurnOutcome[],
      answer: string,
      error: string | null
    ) => ledger.finish(root, outcomes, answer, error)
  ),
})
export const conversationApplication = (ledger: ConversationLedger) =>
  Layer.succeed(Conversations, makeConversations(ledger))
