import { Effect } from "effect"
import { Digest } from "effect/crypto"

export const sha256 = Effect.fnUntraced(function* (text: string) {
  const digest = yield* Digest.Digest
  return yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(text))
})
