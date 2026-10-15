import { Effect, Layer } from "effect"
import { ContinuationIdentity, continuationUuid } from "../identity"
import { failure } from "../contracts"

export const continuationId = Effect.fn("Communication.continuationId")(
  (id: string) =>
    Effect.tryPromise({
      try: () =>
        crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`communication-result:${id}`)
        ),
      catch: () =>
        failure("storage", "Could not derive continuation identity."),
    }).pipe(Effect.map((digest) => continuationUuid(new Uint8Array(digest))))
)
export const WebCryptoContinuationIdentity = Layer.succeed(
  ContinuationIdentity,
  { derive: continuationId }
)
