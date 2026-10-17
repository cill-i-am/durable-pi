import type { Effect } from "effect"

import type {
  ConfigureEmail,
  EmailFailure,
  EmailSettings,
  EmailRecord,
  IncomingEmail,
  EmailDelivery,
} from "./contracts"

export interface EmailPersistence {
  claim: (
    id: string,
    reply: string,
    allowed: () => Effect.Effect<boolean, EmailFailure>
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
      error?: string | null
      providerId?: string | null
    }
  ) => Effect.Effect<boolean, EmailFailure>
}
