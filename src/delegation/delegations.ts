import type { Effect } from "effect"
import type {
  Control,
  DelegateInput,
  DelegationFailure,
  Group,
  Transcript,
} from "./contracts"
import type { DelegationSource } from "./delegation"

export type DelegationAuthority = {
  current: (turnId: string, conversationId: number) => boolean
  cancelled: (turnId: string) => boolean
}
export type Delegations = {
  run: (
    input: DelegateInput,
    source: DelegationSource
  ) => Effect.Effect<string, DelegationFailure>
  list: (offset?: number) => Effect.Effect<Group[], DelegationFailure>
  read: (groupId: number) => Effect.Effect<Group, DelegationFailure>
  control: (
    input: Control
  ) => Effect.Effect<{ accepted: boolean }, DelegationFailure>
  transcript: (
    groupId: number,
    childId: number,
    cursor?: string
  ) => Effect.Effect<Transcript, DelegationFailure>
  /** Resolve a native child to its original root; never use the latest unrelated turn. */
  root: (
    conversationId: number
  ) => Effect.Effect<string | undefined, DelegationFailure>
  /** Called by the existing provider payload hook immediately before each request. */
  request: (providerSessionId: string) => Effect.Effect<void, DelegationFailure>
  /** Enforce saved Stop/deadline intents while the root runner is active. */
  reconcile: (turnId: string) => Effect.Effect<void, DelegationFailure>
}
