import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { PersonalAgent } from "./src/agent/worker"

export const AuthDatabase = Cloudflare.D1.Database("AuthDatabase", {
  migrations: "./migrations/auth",
})
export const AgentWorker = Cloudflare.Worker("AgentWorker", {
  main: "./src/agent/worker.ts",
  dev: { port: 1338, strictPort: true },
  workersDev: { enabled: false, previewsEnabled: false },
  compatibility: { date: "2026-09-25", flags: ["nodejs_compat"] },
  env: {
    AGENT: Cloudflare.DurableObject<PersonalAgent>("PersonalAgent"),
    OPENAI_CREDENTIAL: Config.Redacted("OPENAI_CREDENTIAL").pipe(
      Config.withDefault("")
    ),
    MODEL_ID: Config.String("MODEL_ID").pipe(Config.withDefault("gpt-6.1-sol")),
    SUMMARY_MODEL_ID: Config.String("SUMMARY_MODEL_ID").pipe(
      Config.withDefault("gpt-6-luna")
    ),
  },
})
export const Website = Cloudflare.Website.Vite("Website", {
  dev: { port: 1337, strictPort: true },
  env: {
    DB: AuthDatabase,
    AGENT_SERVICE: AgentWorker,
    BETTER_AUTH_SECRET: Config.Redacted("BETTER_AUTH_SECRET"),
    OWNER_EMAIL: Config.String("OWNER_EMAIL"),
    SETUP_TOKEN: Config.Redacted("SETUP_TOKEN"),
    APP_URL: Cloudflare.Worker.URL,
  },
  compatibility: { date: "2026-09-25", flags: ["nodejs_compat"] },
})
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
    return { url: website.url }
  })
)
