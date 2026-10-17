import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import type { PersonalAgent } from "./src/agent/worker"
import { PASSWORD_EMAIL_FROM } from "./src/auth/password-email"
import type { BackgroundGroupRPC } from "./src/delegation/worker"
import type { NativeCapacityRPC } from "./src/terminal/adapters/capacity"
import type { LinuxSandboxV1 } from "./src/terminal/adapters/native-worker"
import type { LinuxSandbox } from "./src/terminal/worker"
import type { WhatsAppBridgeRpc } from "./src/whatsapp/adapters/bridge-rpc"

const observability = {
  enabled: true,
  headSamplingRate: 1,
  logs: {
    enabled: true,
    invocationLogs: true,
    headSamplingRate: 1,
    persist: true,
  },
  traces: { enabled: true, headSamplingRate: 1, persist: true },
} satisfies Cloudflare.WorkerObservability

export const AuthDatabase = Cloudflare.D1.Database("AuthDatabase", {
  migrations: "./migrations/auth",
})
export const MemoryBackups = Cloudflare.R2.Bucket("MemoryBackups", {
  publicAccess: false,
})
export const WorkspaceAssets = Cloudflare.R2.Bucket("WorkspaceAssets", {
  publicAccess: false,
})
export const UserAvatars = Cloudflare.R2.Bucket("UserAvatars", {
  publicAccess: false,
})
export const DocumentWorker = Cloudflare.Worker("DocumentWorker", {
  main: "./src/workspace/adapters/document-worker.ts",
  dev: { port: 1339, strictPort: true },
  workersDev: { enabled: false, previewsEnabled: false },
  compatibility: { date: "2026-09-25", flags: ["nodejs_compat"] },
  observability,
  limits: { cpuMs: 5_000 },
})
export const ExecutionWorker = Cloudflare.Worker("ExecutionWorker", {
  main: "./src/execution/worker.ts",
  dev: { port: 1340, strictPort: true },
  workersDev: { enabled: false, previewsEnabled: false },
  compatibility: { date: "2026-09-25", flags: ["nodejs_compat"] },
  observability,
  limits: { cpuMs: 2000 },
  env: { LOADER: Cloudflare.WorkerLoader() },
})
export type ExecutionEnv = Cloudflare.InferEnv<typeof ExecutionWorker>
// Separate native namespace preserves the legacy namespace during cutover.
const TerminalImage = Cloudflare.Container("TerminalImage", {
  schedulingPolicy: "durable_object",
  context: "./containers/terminal-native",
  observability: { logs: { enabled: false } },
})
const NativeCapacity: Cloudflare.DurableObjectLike<NativeCapacityRPC> =
  Cloudflare.DurableObject("NativeTerminalCapacity")
export const NativeTerminalWorker = Cloudflare.Worker(
  "TerminalWorkerSandboxV1",
  {
    main: "./src/terminal/adapters/native-worker.ts",
    dev: { port: 1342, strictPort: true },
    workersDev: { enabled: false, previewsEnabled: false },
    compatibility: { date: "2026-10-02", flags: ["nodejs_compat"] },
    observability,
    env: {
      SANDBOX: Cloudflare.DurableObject<LinuxSandboxV1>("LinuxSandboxV1", {
        containers: [TerminalImage],
      }),
      BACKUPS: WorkspaceAssets,
      CAPACITY: NativeCapacity,
    },
  }
)
export type NativeTerminalEnv = Cloudflare.InferEnv<typeof NativeTerminalWorker>
export const TerminalWorker = Cloudflare.Worker(
  "TerminalWorkerDrizzleV1",
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage
    return {
      main: "./src/terminal/worker.ts",
      dev: { port: 1341, strictPort: true },
      workersDev: { enabled: false, previewsEnabled: false },
      compatibility: { date: "2026-09-25", flags: ["nodejs_compat"] },
      observability,
      env: {
        SANDBOX: Cloudflare.Container<LinuxSandbox>("LinuxSandboxDrizzleV1", {
          className: "LinuxSandbox",
          context: "./containers/terminal",
          instanceType: "basic",
          maxInstances: 4,
          observability: { logs: { enabled: false } },
        }),
        BACKUPS: WorkspaceAssets,
        LEGACY_FROZEN: stage === "production",
        NATIVE_SERVICE: NativeTerminalWorker,
        SANDBOX_LOG_LEVEL: "error",
        SANDBOX_TRANSPORT: "rpc",
      },
    }
  })
)
export type TerminalEnv = Cloudflare.InferEnv<typeof TerminalWorker>

export const BackgroundGroups: Cloudflare.DurableObjectLike<BackgroundGroupRPC> =
  Cloudflare.DurableObject<BackgroundGroupRPC>("BackgroundGroup")
export const AgentWorker = Cloudflare.Worker("AgentWorkerDrizzleV1", {
  observability,
  main: "./src/agent/worker.ts",
  dev: { port: 1338, strictPort: true },
  workersDev: { enabled: false, previewsEnabled: false },
  compatibility: { date: "2026-10-17", flags: ["nodejs_compat"] },
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
export const EmailWorker = Cloudflare.Worker("EmailWorker", {
  main: "./src/email/worker.ts",
  dev: { port: 1343, strictPort: true },
  workersDev: { enabled: false, previewsEnabled: false },
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
      workersDev: { enabled: false, previewsEnabled: false },
      domain:
        stage === "production"
          ? {
              name: "whatsapp.cill-i-am.com",
              zoneId: "37e485d6619dee244939e66e1ee90d3f",
            }
          : undefined,
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
export const Website = Cloudflare.Website.Vite(
  "Website",
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage
    const owner = yield* Config.String("OWNER_EMAIL").pipe(Effect.orDie)
    return {
      observability,
      dev: { port: 1337, strictPort: true },
      domain:
        stage === "production"
          ? {
              name: "bot.cill-i-am.com",
              zoneId: "37e485d6619dee244939e66e1ee90d3f",
            }
          : undefined,
      env: {
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
export type AgentEnv = Cloudflare.InferEnv<typeof AgentWorker>
export type WebsiteEnv = Cloudflare.InferEnv<typeof Website>

export default Alchemy.Stack(
  "durable-pi",
  {
    providers: Cloudflare.providers(),
    state: Layer.unwrap(
      Effect.map(Alchemy.AlchemyContext, ({ dev }) =>
        dev ? Alchemy.localState() : Cloudflare.state()
      )
    ),
  },
  Effect.gen(function* () {
    const website = yield* Website
    yield* EmailWorker
    yield* WhatsAppWorker
    return { url: website.url }
  })
)
