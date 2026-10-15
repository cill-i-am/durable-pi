import type { JobType, ResolvedRoute } from "../inference/policy"
import type { SkillDocument } from "../skills/contracts"
import type { StatusTurn } from "./status"
import type {
  ModelSettings,
  ModelSelection,
  Submission,
  Turn,
  PreparedMessage,
  TurnOutcome,
  TurnAdmission,
} from "./turns"

/** Native synchronous transactions own admission and completion. Callers may
 * compose admission in the same transaction group without crossing a runtime. */
export interface ConversationLedger {
  readonly transactionGroup: object
  jobSetting: (job: JobType) => ModelSettings | undefined
  setJobSetting: (
    job: JobType,
    settings: ModelSettings
  ) => ModelSelection | undefined
  settings: () => ModelSettings
  setSettings: (settings: ModelSettings) => ModelSelection
  selection: () => ModelSelection
  get: (id: string) => Turn | undefined
  active: () => Turn | undefined
  recent: () => Turn[]
  statusTurns: () => { active?: StatusTurn; latest?: StatusTurn }
  members: (rootId: string, includeInput?: boolean) => Turn[]
  admit: (
    input: Submission,
    prepared?: PreparedMessage,
    skills?: readonly SkillDocument[],
    resolved?: ResolvedRoute
  ) => TurnAdmission
  prepare: (id: string) => void
  savePrompt: (id: string, prompt: string) => void
  saveSession: (id: string, session: string) => void
  submitted: (id: string, session: string) => void
  consumed: (id: string) => void
  requestStop: (id: string) => string | undefined
  finish: (
    root: Turn,
    outcomes: readonly TurnOutcome[],
    answer: string,
    error: string | null
  ) => boolean
}
