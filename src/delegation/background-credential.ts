import { Effect } from "effect"

import type { BackgroundError } from "./background-mailbox"
import { DelegationFailure } from "./contracts"

/** A lookup can wait for account-owned rotation. A stopped group must not
 * receive the token when that lookup eventually settles. */
export function backgroundCredential<TToken, TError, TRequirements>(
  authorized: (id: number) => Effect.Effect<boolean, BackgroundError>,
  resolve: (provider: string) => Effect.Effect<TToken, TError, TRequirements>
) {
  return Effect.fn("Background.credential")(function* (
    id: number,
    provider: string
  ) {
    const stopped = () =>
      new DelegationFailure({
        code: "cancelled",
        message: "Background group stopped.",
      })
    if (provider !== "openai" || !(yield* authorized(id)))
      return yield* stopped()
    const credential = yield* resolve(provider)
    if (!(yield* authorized(id))) return yield* stopped()
    return credential
  })
}
