import type { Effect } from "effect"
import { Context } from "effect"

import type { ConversationFailure } from "../conversations/turns"
import type {
  Delivery,
  Envelope,
  Identity,
  Outcome,
  Receipt,
  Task,
  CommunicationError,
  ControlAttempt,
  TaskRelease,
  TaskClaim,
  DiscoveryAdmission,
} from "./contracts"

export type ContinuationAdmission = {
  transactionGroup: object
  operationId: string
  control?: ControlAttempt
  admit: (
    task: Task
  ) => Effect.Effect<
    { kind: "admitted"; turnId: string } | { kind: "discarded" },
    ConversationFailure
  >
}

export class Mailbox extends Context.Service<
  Mailbox,
  {
    readonly transactionGroup: object
    identity: () => Effect.Effect<Identity, CommunicationError>
    enqueue: (
      envelope: Envelope,
      now: number,
      options?: DiscoveryAdmission
    ) => Effect.Effect<Delivery, CommunicationError>
    prove: (envelope: Envelope) => Effect.Effect<boolean, CommunicationError>
    accept: (
      envelope: Envelope,
      now: number,
      options?: DiscoveryAdmission
    ) => Effect.Effect<Receipt, CommunicationError>
    accepted: (
      envelope: Envelope
    ) => Effect.Effect<Receipt | undefined, CommunicationError>
    deliveries: () => Effect.Effect<readonly Delivery[], CommunicationError>
    tasks: () => Effect.Effect<readonly Task[], CommunicationError>
    byTurn: (id: string) => Effect.Effect<readonly Task[], CommunicationError>
    pending: () => Effect.Effect<readonly Task[], CommunicationError>
    recovery: () => Effect.Effect<readonly Task[], CommunicationError>
    resume: (
      id: string,
      admission: ContinuationAdmission
    ) => Effect.Effect<void, CommunicationError>
    discard: (
      id: string,
      control?: ControlAttempt
    ) => Effect.Effect<void, CommunicationError>
    task: (id: string) => Effect.Effect<Task, CommunicationError>
    claimDelivery: (
      now: number
    ) => Effect.Effect<Delivery | undefined, CommunicationError>
    delivered: (
      id: string,
      attempt: number,
      receipt: Receipt
    ) => Effect.Effect<void, CommunicationError>
    deliveryFailed: (
      id: string,
      attempt: number,
      now: number,
      delay: number,
      permanent: boolean
    ) => Effect.Effect<void, CommunicationError>
    claimContinuation: (
      id: string,
      now: number,
      options: TaskClaim
    ) => Effect.Effect<Task | undefined, CommunicationError>
    claimTask: (
      now: number,
      options: TaskClaim
    ) => Effect.Effect<Task | undefined, CommunicationError>
    finish: (
      id: string,
      revision: number,
      outcome: Outcome,
      now: number,
      owner: string
    ) => Effect.Effect<void, CommunicationError>
    releaseTask: (
      receipt: TaskRelease
    ) => Effect.Effect<boolean, CommunicationError>
    restoreControl: (now: number) => Effect.Effect<void, CommunicationError>
    exhaustControl: (
      attempt: ControlAttempt,
      now: number,
      current: () => boolean
    ) => Effect.Effect<boolean, CommunicationError>
    cancel: (id: string, now: number) => Effect.Effect<Task, CommunicationError>
    retry: (
      id: string,
      now: number,
      options?: DiscoveryAdmission
    ) => Effect.Effect<void, CommunicationError>
    expire: (now: number) => Effect.Effect<void, CommunicationError>
    nextWake: () => Effect.Effect<number | undefined, CommunicationError>
  }
>()("durable-pi/communication/Mailbox") {}

export class MailboxTransport extends Context.Service<
  MailboxTransport,
  {
    deliver: (envelope: Envelope) => Effect.Effect<Receipt, CommunicationError>
    permitted: (
      envelope: Envelope
    ) => Effect.Effect<boolean, CommunicationError>
    authenticate: (
      envelope: Envelope
    ) => Effect.Effect<void, CommunicationError>
  }
>()("durable-pi/communication/Transport") {}
