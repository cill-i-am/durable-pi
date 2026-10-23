import type { Effect } from "effect"

import type { ReplyProgress, ReplyLease, ReplyWork } from "../replies/contracts"
import type {
  ConfigureEmail,
  EmailFailure,
  EmailSettings,
  EmailRecord,
  IncomingEmail,
} from "./contracts"

export interface EmailPersistence {
  decide: <A, E>(
    id: string,
    allowed: () => Effect.Effect<boolean, EmailFailure>,
    body: () => Effect.Effect<A, E>
  ) => Effect.Effect<A, E | EmailFailure>
  notice: (
    parent: EmailRecord,
    key: string,
    reply: string,
    discoveryDeadline: number
  ) => Effect.Effect<void, EmailFailure>
  claim: (
    id: string,
    reply: string,
    allowed: () => Effect.Effect<boolean, EmailFailure>,
    delivery?: ReplyProgress,
    from?: "waiting" | "sending",
    lease?: ReplyLease
  ) => Effect.Effect<boolean, EmailFailure>
  settings: () => Effect.Effect<EmailSettings, EmailFailure>
  configure: (
    input: ConfigureEmail
  ) => Effect.Effect<EmailSettings, EmailFailure>
  get: (id: string) => Effect.Effect<EmailRecord | undefined, EmailFailure>
  list: () => Effect.Effect<readonly EmailRecord[], EmailFailure>
  pending: () => Effect.Effect<readonly EmailRecord[], EmailFailure>
  receive: (
    input: IncomingEmail,
    generation: number,
    discoveryDeadline: number
  ) => Effect.Effect<boolean, EmailFailure>
  prepared: (
    id: string,
    reply?: string,
    revision?: number
  ) => Effect.Effect<boolean, EmailFailure>
  cancel: (id: string, error: string) => Effect.Effect<boolean, EmailFailure>
  checkpoint: (
    id: string,
    attemptId: string,
    delivery: ReplyProgress
  ) => Effect.Effect<boolean, EmailFailure>
  finish: (
    id: string,
    attemptId: string,
    state: "sent" | "failed" | "uncertain",
    providerId: string | null,
    error: string | null
  ) => Effect.Effect<boolean, EmailFailure>
  recoverAttempt: (
    id: string,
    attemptId: string
  ) => Effect.Effect<boolean, EmailFailure>
  recover: (force?: boolean) => Effect.Effect<void, EmailFailure>
  getPendingWork: (
    id: string
  ) => Effect.Effect<ReplyWork<EmailRecord> | undefined, EmailFailure>
  renewWork: (
    id: string,
    revision: number,
    deadline: number
  ) => Effect.Effect<boolean, EmailFailure>
  nextRecovery: () => Effect.Effect<number | undefined, EmailFailure>
}
