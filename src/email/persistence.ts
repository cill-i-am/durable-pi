import type { Effect } from "effect"

import type { ReplyProgress } from "../replies/contracts"
import type {
  ConfigureEmail,
  EmailFailure,
  EmailSettings,
  EmailRecord,
  IncomingEmail,
  EmailDelivery,
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
    reply: string
  ) => Effect.Effect<void, EmailFailure>
  claim: (
    id: string,
    reply: string,
    allowed: () => Effect.Effect<boolean, EmailFailure>,
    delivery?: ReplyProgress,
    from?: "waiting" | "sending"
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
    generation: number
  ) => Effect.Effect<boolean, EmailFailure>
  update: (
    id: string,
    from: EmailDelivery,
    state: EmailDelivery,
    details?: {
      reply?: string
      delivery?: ReplyProgress
      error?: string | null
      providerId?: string | null
    }
  ) => Effect.Effect<boolean, EmailFailure>
}
