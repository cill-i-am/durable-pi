import { Effect, Schema } from "effect"
import type {
  Credential,
  CredentialStore,
  OAuthAuth,
} from "@earendil-works/pi-ai"
import { runObserved } from "../../observability/worker"
import {
  ModelCredential,
  OAuthCredential,
  CredentialUnavailable,
  CredentialCorrupt,
} from "../credentials"
import { refreshOAuth } from "./oauth"

export const toNativeCredential = (value: ModelCredential): Credential =>
  Schema.encodeSync(ModelCredential)(value)
export const decodeCredential = (raw: unknown): Credential => {
  try {
    return toNativeCredential(Schema.decodeUnknownSync(ModelCredential)(raw))
  } catch {
    throw new CredentialCorrupt()
  }
}
export const workerChatGPTAuth: OAuthAuth = {
  name: "Sign in with ChatGPT",
  isSubscription: true,
  login: async () => {
    throw new Error("Run pnpm model:login on your own computer")
  },
  toAuth: async (credential) => ({ apiKey: credential.access }),
  refresh: (credential, signal) =>
    runObserved(
      Effect.yieldNow.pipe(
        Effect.andThen(
          Schema.decodeUnknownEffect(OAuthCredential)(credential).pipe(
            Effect.mapError(
              () => new CredentialUnavailable({ message: "Reconnect ChatGPT" })
            ),
            Effect.flatMap((current) => refreshOAuth(current)),
            Effect.map(toNativeCredential),
            Effect.flatMap((next) =>
              next.type === "oauth"
                ? Effect.succeed(next)
                : Effect.die(
                    "OAuth refresh returned a different credential type"
                  )
            )
          )
        )
      ),
      { signal }
    ),
}

/** A child may resolve the owner's token; it cannot refresh, persist or delete it. */
export function accountCredentials(
  resolve: (
    provider: string,
    signal?: AbortSignal
  ) => Promise<Credential | undefined>
): CredentialStore {
  return {
    read: (provider, options) => resolve(provider, options?.signal),
    modify: (provider, _update, options) => resolve(provider, options?.signal),
    list: async () => {
      const credential = await resolve("openai")
      return credential ? [{ providerId: "openai", type: credential.type }] : []
    },
    delete: async () => {
      throw new Error("Manage the model connection on the owner account")
    },
  }
}
