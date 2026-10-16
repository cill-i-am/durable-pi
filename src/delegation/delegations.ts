import type { Effect } from "effect"
import type {
  Control,
  DelegateInput,
  DelegationFailure,
  Group,
  Transcript,
} from "./contracts"
import type { DelegationSource } from "./delegation"

export type DelegationFacts = {
  current: (turnId: string, conversationId: number) => boolean
  cancelled: (turnId: string) => boolean
}
export type DelegationAuthority = {
  current: (
    turnId: string,
    conversationId: number
  ) => boolean | Effect.Effect<boolean, DelegationFailure>
  cancelled: (
    turnId: string
  ) => boolean | Effect.Effect<boolean, DelegationFailure>
}
export type DelegationQueries<TError = DelegationFailure> = {
  list: (offset?: number) => Effect.Effect<Group[], TError>
  read: (groupId: number) => Effect.Effect<Group, TError>
  control: (input: Control) => Effect.Effect<{ accepted: boolean }, TError>
  transcript: (
    groupId: number,
    childId: number,
    cursor?: string
  ) => Effect.Effect<Transcript, TError>
}
export type Delegations = DelegationQueries & {
  run: (
    input: DelegateInput,
    source: DelegationSource
  ) => Effect.Effect<string, DelegationFailure>
  root: (
    conversationId: number
  ) => Effect.Effect<string | undefined, DelegationFailure>
  request: (providerSessionId: string) => Effect.Effect<void, DelegationFailure>
  reconcile: (turnId: string) => Effect.Effect<void, DelegationFailure>
}
