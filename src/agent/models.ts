import { createModels } from "@earendil-works/pi-ai/models"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import type {
  Credential,
  CredentialStore,
  OAuthAuth,
} from "@earendil-works/pi-ai"
import * as Schema from "effect/Schema"
import type { Sqlite } from "./memory"

const OAuthCredentialSchema = Schema.Struct({
  type: Schema.Literal("oauth"),
  access: Schema.String,
  refresh: Schema.String,
  expires: Schema.Number,
  clientId: Schema.String,
})
const ApiCredentialSchema = Schema.Struct({
  type: Schema.Literal("api_key"),
  key: Schema.String,
})
const CredentialSchema = Schema.Union([
  OAuthCredentialSchema,
  ApiCredentialSchema,
])
const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Number,
  scope: Schema.String,
})
export const decodeCredential = Schema.decodeUnknownSync(CredentialSchema)

/** Pi's login flow owns a Node callback server. Only its refresh protocol runs in workerd. */
export const workerChatGPTAuth: OAuthAuth = {
  name: "Sign in with ChatGPT",
  isSubscription: true,
  login: async () => {
    throw new Error("Run pnpm model:login on your own computer")
  },
  toAuth: async (credential) => ({ apiKey: credential.access }),
  refresh: async (credential, signal) => {
    if (typeof credential.clientId !== "string")
      throw new Error("Reconnect ChatGPT")
    const response = await fetch(
      "https://auth.openai.com/api/accounts/oauth/token",
      {
        method: "POST",
        signal,
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: credential.clientId,
          refresh_token: credential.refresh,
          resource: "https://api.openai.com/v1",
        }),
      }
    )
    if (!response.ok)
      throw new Error(
        "ChatGPT authorization expired. Reconnect with pnpm model:login."
      )
    const data = Schema.decodeUnknownSync(TokenResponse)(await response.json())
    if (
      !data.scope.split(/\s+/).includes("chatgpt.tokens.use.direct") ||
      data.expires_in <= 0
    )
      throw new Error("ChatGPT grant does not permit model requests")
    return {
      ...credential,
      access: data.access_token,
      refresh: data.refresh_token,
      expires: Date.now() + data.expires_in * 1000 - 180_000,
    }
  },
}

export class DurableCredentials implements CredentialStore {
  private lock = Promise.resolve()
  constructor(
    readonly db: Sqlite,
    readonly seed: string
  ) {
    db.run(
      "CREATE TABLE IF NOT EXISTS model_credentials (provider TEXT PRIMARY KEY, value TEXT NOT NULL, seed TEXT NOT NULL)"
    )
  }
  async read(providerId: string): Promise<Credential | undefined> {
    const row = this.db.all<{ value: string; seed: string }>(
      "SELECT value,seed FROM model_credentials WHERE provider=?",
      providerId
    )[0]
    // A new deployment credential explicitly replaces the old grant; unchanged seeds retain rotated tokens.
    if (this.seed && (!row || row.seed !== this.seed)) {
      const credential = decodeCredential(JSON.parse(this.seed))
      this.db.run(
        "INSERT INTO model_credentials VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET value=excluded.value,seed=excluded.seed",
        providerId,
        JSON.stringify(credential),
        this.seed
      )
      return credential
    }
    return row ? decodeCredential(JSON.parse(row.value)) : undefined
  }
  async list() {
    const credential = await this.read("openai")
    return credential ? [{ providerId: "openai", type: credential.type }] : []
  }
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    const prior = this.lock
    let unlock!: () => void
    this.lock = new Promise<void>((resolve) => {
      unlock = resolve
    })
    await prior
    try {
      const current = await this.read(providerId),
        next = await fn(current)
      if (next)
        this.db.run(
          "INSERT INTO model_credentials VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET value=excluded.value,seed=excluded.seed",
          providerId,
          JSON.stringify(next),
          this.seed
        )
      return next ?? current
    } finally {
      unlock()
    }
  }
  async delete(providerId: string) {
    await this.modify(providerId, async () => {
      this.db.run("DELETE FROM model_credentials WHERE provider=?", providerId)
      return undefined
    })
  }
}

export function createAgentModels(credentials: CredentialStore) {
  const models = createModels({
    credentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  })
  const provider = openaiProvider()
  models.setProvider({
    ...provider,
    auth: { ...provider.auth, oauth: workerChatGPTAuth },
  })
  return models
}
