import { Crypto, Effect } from "effect"

import { preserveFatal } from "../shared/effect"
import { InvalidMemory } from "./domain"

export const sha256 = Effect.fnUntraced(function* (text: string) {
  const crypto = yield* Crypto.Crypto
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(text))
    .pipe(
      preserveFatal,
      Effect.mapError(
        () =>
          new InvalidMemory({
            message: "Memory checksum could not be computed",
          })
      )
    )
  return Array.from(digest)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("")
})
