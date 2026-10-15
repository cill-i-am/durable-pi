import type { Effect } from "effect"
import type { BackgroundHandoff } from "./background"
import type { BackgroundChild, BackgroundState } from "./background-task-domain"
import type { DelegationFailure, TaskBrief, Transcript } from "./contracts"
import type { ChildFacts } from "./domain"

export interface BackgroundTaskTransaction {
  readonly state: () => Effect.Effect<
    { value: BackgroundState | null },
    DelegationFailure
  >
  readonly createChild: (
    handoff: BackgroundHandoff,
    task: TaskBrief
  ) => Effect.Effect<
    Pick<BackgroundChild, "id" | "provider">,
    DelegationFailure
  >
}
/** One actual native document commit, with the caller's Context and Cause.
 * Mutable state views cannot outlive that commit. Child allocation/configuration
 * and the handoff are committed together. */
export interface BackgroundTaskLedger {
  readonly atomic: <T, TError, TRequirements>(
    body: (
      tx: BackgroundTaskTransaction
    ) => Effect.Effect<T, TError, TRequirements>
  ) => Effect.Effect<T, TError | DelegationFailure, TRequirements>
  readonly state: () => Effect.Effect<
    BackgroundState | undefined,
    DelegationFailure
  >
  readonly facts: (
    state: BackgroundState
  ) => Effect.Effect<readonly ChildFacts[], DelegationFailure>
  readonly hasSubmission: (
    child: number,
    request: string
  ) => Effect.Effect<boolean, DelegationFailure>
  readonly submit: (
    child: number,
    text: string,
    request: string,
    steer: boolean
  ) => Effect.Effect<void, DelegationFailure>
  readonly abort: (child: number) => Effect.Effect<void, DelegationFailure>
  readonly transcript: (
    child: number,
    before?: number
  ) => Effect.Effect<Transcript, DelegationFailure>
}
