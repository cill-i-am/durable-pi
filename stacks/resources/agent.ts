import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Alchemy from "alchemy"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"

import type { PersonalAgent } from "../../src/agent/worker"
import { PASSWORD_EMAIL_FROM } from "../../src/auth/password-email"
import type { BackgroundGroupRPC } from "../../src/delegation/worker"
import type { WhatsAppBridgeRpc } from "../../src/whatsapp/adapters/bridge-rpc"
import { DocumentWorker, ExecutionWorker } from "./services"
import { AuthDatabase, MemoryBackups, WorkspaceAssets } from "./storage"
import { NativeTerminalWorker } from "./terminal"
import { privateWorker } from "./worker-settings"

export const BackgroundGroups: Cloudflare.DurableObjectLike<BackgroundGroupRPC> =
  Cloudflare.DurableObject<BackgroundGroupRPC>("BackgroundGroup")
export const AgentWorker = Cloudflare.Worker("AgentWorkerDrizzleV1", {
  main: "./src/agent/worker.ts",
  build: {
    input: {
      transform: {
        define: {
          __PI_BUILD_REVISION__: JSON.stringify(
            process.env.GITHUB_SHA ?? "development"
          ),
        },
      },
    },
  },
  dev: { port: 1338, strictPort: true },
  ...privateWorker,
  // With the production bindings, the new registry exceeds startup limits;
  // the same code and bindings validate at 379ms with the legacy registry.
  compatibility: {
    date: "2026-10-17",
    flags: ["nodejs_compat", "legacy_module_registry", "enable_request_signal"],
  },
  env: {
    AGENT: Cloudflare.DurableObject<PersonalAgent>("PersonalAgent"),
    AUTH_DB: AuthDatabase,
    BETTER_AUTH_SECRET: Config.Redacted("BETTER_AUTH_SECRET"),
    AUTH_EMAIL: Cloudflare.Email.SendEmail("AgentAuthEmail", {
      allowedSenderAddresses: [PASSWORD_EMAIL_FROM],
    }),
    WHATSAPP: Cloudflare.DurableObject<WhatsAppBridgeRpc>("WhatsAppBridge"),
    WHATSAPP_ACCESS_TOKEN: Config.Redacted("WHATSAPP_ACCESS_TOKEN").pipe(
      Config.withDefault("")
    ),
    WHATSAPP_APP_SECRET: Config.Redacted("WHATSAPP_APP_SECRET").pipe(
      Config.withDefault("")
    ),
    WHATSAPP_VERIFY_TOKEN: Config.Redacted("WHATSAPP_VERIFY_TOKEN").pipe(
      Config.withDefault("")
    ),
    WHATSAPP_PHONE_NUMBER_ID: Config.String("WHATSAPP_PHONE_NUMBER_ID").pipe(
      Config.withDefault("")
    ),
    WHATSAPP_OWNER_ID: Config.Redacted("WHATSAPP_OWNER_ID").pipe(
      Config.withDefault("")
    ),
    WHATSAPP_BUSINESS_NUMBER: Config.String("WHATSAPP_BUSINESS_NUMBER").pipe(
      Config.withDefault("")
    ),
    BACKGROUND: BackgroundGroups,
    MEMORY_BACKUPS: MemoryBackups,
    WORKSPACE_ASSETS: WorkspaceAssets,
    IMAGES: Cloudflare.Images.Images("IMAGES"),
    AI: Cloudflare.Workers.AI(),
    DOCUMENT_SERVICE: DocumentWorker,
    EXECUTION_SERVICE: ExecutionWorker,
    TERMINAL_SERVICE: NativeTerminalWorker,
    BROWSER: Cloudflare.Browser().pipe(Alchemy.remote()),
    OPENAI_CREDENTIAL: Config.Redacted("OPENAI_CREDENTIAL").pipe(
      Config.withDefault("")
    ),
    MODEL_ID: Config.String("MODEL_ID").pipe(Config.withDefault("gpt-6.1-sol")),
    OWNER_EMAIL: Config.String("OWNER_EMAIL"),
    AGENT_EMAIL_DOMAIN: Config.String("AGENT_EMAIL_DOMAIN").pipe(
      Config.withDefault("")
    ),
    EMAIL_ADDRESS_SECRET: Config.Redacted("EMAIL_ADDRESS_SECRET").pipe(
      Config.withDefault("")
    ),
    EMAIL_REVIEW_URL: Config.String("EMAIL_REVIEW_URL").pipe(
      Config.withDefault("https://bot.cill-i-am.com"),
      Config.map((value) => value || "https://bot.cill-i-am.com")
    ),
    AGENT_EMAIL: Effect.gen(function* () {
      const owner = yield* Config.String("OWNER_EMAIL")
      return yield* Cloudflare.Email.SendEmail("AgentEmail", {
        allowedDestinationAddresses: [owner],
      })
    }),
  },
})

export type AgentEnv = Cloudflare.InferEnv<typeof AgentWorker>
