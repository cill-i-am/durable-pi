import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Alchemy from "alchemy"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"

import { AgentWorker } from "./agent"
import { AuthDatabase } from "./storage"
import { privateWorker, productionDomain } from "./worker-settings"

export const EmailWorker = Cloudflare.Worker("EmailWorker", {
  main: "./src/email/worker.ts",
  dev: { port: 1343, strictPort: true },
  ...privateWorker,
  compatibility: { date: "2026-10-17", flags: ["nodejs_compat"] },
  observability: { enabled: false },
  env: {
    AUTH_DB: AuthDatabase,
    AGENT_SERVICE: AgentWorker,
    OWNER_EMAIL: Config.String("OWNER_EMAIL"),
    AGENT_EMAIL_DOMAIN: Config.String("AGENT_EMAIL_DOMAIN").pipe(
      Config.withDefault("")
    ),
  },
})
export type EmailEnv = Cloudflare.InferEnv<typeof EmailWorker>
export const WhatsAppWorker = Cloudflare.Worker(
  "WhatsAppWorker",
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage
    return {
      main: "./src/whatsapp/worker.ts",
      dev: { port: 1344, strictPort: true },
      ...privateWorker,
      domain: productionDomain(stage, "whatsapp.cill-i-am.com"),
      compatibility: { date: "2026-10-17", flags: ["nodejs_compat"] },
      observability: { enabled: false },
      env: {
        AUTH_DB: AuthDatabase,
        AGENT_SERVICE: AgentWorker,
        OWNER_EMAIL: Config.String("OWNER_EMAIL"),
      },
    }
  })
)
export type WhatsAppEnv = Cloudflare.InferEnv<typeof WhatsAppWorker>
