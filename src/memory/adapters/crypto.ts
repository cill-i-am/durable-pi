import { Crypto, Effect, Layer, PlatformError } from "effect"

export const webCryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.tryPromise({
        try: () => crypto.subtle.digest(algorithm, new Uint8Array(data)),
        catch: () =>
          PlatformError.systemError({
            _tag: "Unknown",
            module: "Crypto",
            method: "digest",
          }),
      }).pipe(Effect.map((buffer) => new Uint8Array(buffer))),
  })
)
