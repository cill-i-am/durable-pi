import { Effect, Layer } from "effect"
import { recoveryIdentity } from "../recovery"
import { RecoveryFingerprint, RecoveryHashError } from "../recovery-service"

const digest = async (identity: string) => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(identity)
  )
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}
export const recoveryFingerprint = (value: unknown) =>
  digest(recoveryIdentity(value))
export const webCryptoRecoveryFingerprint: typeof RecoveryFingerprint.Service =
  {
    derive: Effect.fn("Conversations.hashRecovery")(function* (value: unknown) {
      const identity = recoveryIdentity(value)
      return yield* Effect.suspend(() => {
        let pending: Promise<string> | undefined
        return Effect.tryPromise({
          try: () => {
            pending = digest(identity)
            return pending
          },
          catch: (cause) => new RecoveryHashError({ cause }),
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              pending
                ? Effect.promise(() =>
                    pending!.then(
                      () => {},
                      () => {}
                    )
                  )
                : Effect.void
            )
          )
        )
      })
    }),
  }
export const webCryptoRecoveryLayer = Layer.succeed(
  RecoveryFingerprint,
  webCryptoRecoveryFingerprint
)
