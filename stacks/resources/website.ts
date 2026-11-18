import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Alchemy from "alchemy"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"

import { PASSWORD_EMAIL_FROM } from "../../src/auth/password-email"
import { AgentWorker } from "./agent"
import { AuthDatabase, UserAvatars } from "./storage"
import { observability, productionDomain } from "./worker-settings"

export const Website = Cloudflare.Website.Vite(
  "Website",
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage
    const owner = yield* Config.String("OWNER_EMAIL").pipe(Effect.orDie)
    return {
      observability,
      dev: { port: 1337, strictPort: true },
      domain: productionDomain(stage, "bot.cill-i-am.com"),
      env: {
        // Changing the release also invalidates Alchemy's Vite build metadata.
        VITE_BUILD_ID: process.env.GITHUB_SHA ?? "development",
        DB: AuthDatabase,
        USER_AVATARS: UserAvatars,
        AGENT_SERVICE: AgentWorker,
        BETTER_AUTH_SECRET: Config.Redacted("BETTER_AUTH_SECRET"),
        OWNER_EMAIL: owner,
        AUTH_EMAIL: Cloudflare.Email.SendEmail("AuthEmail", {
          allowedSenderAddresses: [PASSWORD_EMAIL_FROM],
        }),
        SETUP_TOKEN: Config.Redacted("SETUP_TOKEN"),
        APP_URL: Cloudflare.Worker.URL,
      },
      compatibility: {
        date: "2026-09-25",
        flags: ["nodejs_compat", "enable_request_signal"],
      },
    }
  })
)
export type WebsiteEnv = Cloudflare.InferEnv<typeof Website>
