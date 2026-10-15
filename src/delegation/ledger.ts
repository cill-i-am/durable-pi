import type { Effect } from "effect"
import type { DelegationFailure, TaskBrief, Transcript } from "./contracts"
import type { DelegationSource } from "./delegation"
import type { ChildFacts, SavedGroup } from "./domain"

export interface DelegationTransaction {
  owner: (
    task: number
  ) => Effect.Effect<
    { conversationId: number; abortRequested: boolean } | undefined,
    DelegationFailure
  >
  parent: (turn: string) => Effect.Effect<{ group: number }, DelegationFailure>
  group: (
    id: number
  ) => Effect.Effect<{ value: SavedGroup | null }, DelegationFailure>
  catalog: () => Effect.Effect<{ ids: number[] }, DelegationFailure>
  operation: (
    id: string
  ) => Effect.Effect<{ input: string; applied: boolean }, DelegationFailure>
  createChild: (
    source: DelegationSource,
    task: TaskBrief
  ) => Effect.Effect<number, DelegationFailure>
}
/** Mutable document views stay within one actual Pi commit. The adapter must
 * preserve callback Context/Cause and join native completion before returning. */
export interface DelegationLedger {
  atomic: <T, TError, TRequirements>(
    body: (tx: DelegationTransaction) => Effect.Effect<T, TError, TRequirements>
  ) => Effect.Effect<T, TError | DelegationFailure, TRequirements>
  availableTools: () => Effect.Effect<readonly string[], DelegationFailure>
  group: (id: number) => Effect.Effect<SavedGroup, DelegationFailure>
  catalog: () => Effect.Effect<readonly number[], DelegationFailure>
  parent: (turn: string) => Effect.Effect<number | undefined, DelegationFailure>
  child: (id: number) => Effect.Effect<number | undefined, DelegationFailure>
  provider: (
    session: string
  ) => Effect.Effect<
    { group: number; child: number } | undefined,
    DelegationFailure
  >
  operation: (
    id: string
  ) => Effect.Effect<
    { input: string; applied: boolean } | undefined,
    DelegationFailure
  >
  facts: (
    group: SavedGroup
  ) => Effect.Effect<readonly ChildFacts[], DelegationFailure>
  hasSubmission: (
    child: number,
    request: string
  ) => Effect.Effect<boolean, DelegationFailure>
  submit: (
    child: number,
    text: string,
    request: string,
    steer: boolean
  ) => Effect.Effect<number, DelegationFailure>
  wait: (submission: number) => Effect.Effect<void, DelegationFailure>
  waitRequest: (
    child: number,
    request: string
  ) => Effect.Effect<void, DelegationFailure>
  abort: (child: number) => Effect.Effect<void, DelegationFailure>
  transcript: (
    child: number,
    before?: number
  ) => Effect.Effect<Transcript, DelegationFailure>
}
