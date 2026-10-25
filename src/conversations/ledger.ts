import type { Effect } from "effect"

import type { JobType, ResolvedRoute } from "../inference/policy"
import type { SkillDocument } from "../skills/contracts"
import type { ConversationError } from "./service"
import type { StatusTurn } from "./status"
import type {
  AdmissionDiscovery,
  StopDiscovery,
  ControlPhase,
  ControlRelease,
  ModelSettings,
  ModelSelection,
  Submission,
  Turn,
  PreparedMessage,
  TurnOutcome,
  TurnAdmission,
} from "./turns"

/** Effect operations share the database coordinator during atomic admission. */
export interface ConversationLedger {
  readonly transactionGroup: object
  jobSetting: (
    job: JobType
  ) => Effect.Effect<ModelSettings | undefined, ConversationError>
  setJobSetting: (
    job: JobType,
    settings: ModelSettings
  ) => Effect.Effect<ModelSelection | undefined, ConversationError>
  settings: () => Effect.Effect<ModelSettings, ConversationError>
  setSettings: (
    settings: ModelSettings
  ) => Effect.Effect<ModelSelection, ConversationError>
  selection: () => Effect.Effect<ModelSelection, ConversationError>
  get: (id: string) => Effect.Effect<Turn | undefined, ConversationError>
  active: () => Effect.Effect<Turn | undefined, ConversationError>
  recent: () => Effect.Effect<Turn[], ConversationError>
  statusTurns: () => Effect.Effect<
    { active?: StatusTurn; latest?: StatusTurn },
    ConversationError
  >
  members: (
    rootId: string,
    includeInput?: boolean
  ) => Effect.Effect<Turn[], ConversationError>
  visibleMembers: (
    rootIds: readonly string[]
  ) => Effect.Effect<Turn[], ConversationError>
  admit: (
    input: Submission,
    prepared?: PreparedMessage,
    skills?: readonly SkillDocument[],
    resolved?: ResolvedRoute,
    options?: AdmissionDiscovery
  ) => Effect.Effect<TurnAdmission, ConversationError>
  saveAttachments: (
    id: string,
    prepared: PreparedMessage,
    owner?: string
  ) => Effect.Effect<boolean, ConversationError>
  prepare: (
    id: string,
    owner?: string
  ) => Effect.Effect<void, ConversationError>
  savePrompt: (
    id: string,
    prompt: string,
    owner?: string
  ) => Effect.Effect<void, ConversationError>
  saveSession: (
    id: string,
    session: string,
    owner?: string
  ) => Effect.Effect<void, ConversationError>
  submitted: (
    id: string,
    session: string,
    owner?: string
  ) => Effect.Effect<void, ConversationError>
  consumed: (
    id: string,
    owner?: string
  ) => Effect.Effect<void, ConversationError>
  requestStop: (
    id: string,
    options?: StopDiscovery
  ) => Effect.Effect<string | undefined, ConversationError>
  claimControl: (
    id: string,
    owner: string,
    deadline: number,
    mode?: "automatic" | "inspect" | "stop",
    expectedRevision?: number
  ) => Effect.Effect<Turn | undefined, ConversationError>
  releaseControl: (
    id: string,
    owner: string,
    confirmed?: boolean,
    result?: ControlRelease
  ) => Effect.Effect<boolean, ConversationError>
  exhaustControl: (
    id: string,
    expectedRevision: number,
    phase: ControlPhase,
    error: string,
    eligible: () => boolean
  ) => Effect.Effect<boolean, ConversationError>
  restoreControl: () => Effect.Effect<void, ConversationError>
  retryStop: (
    id: string,
    expectedRevision: number,
    discoveryDeadline: number
  ) => Effect.Effect<boolean, ConversationError>
  finish: (
    root: Turn,
    outcomes: readonly TurnOutcome[],
    answer: string,
    error: string | null,
    owner?: string
  ) => Effect.Effect<boolean, ConversationError>
}
