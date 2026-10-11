import { Schema } from "effect"
import { ModelSettings, ThinkingLevel } from "./selection"

export const POLICY_VERSION = "jobs-v1"
export const jobTypes = [
  "conversation",
  "implementation",
  "planning",
  "review",
  "labels",
  "extraction",
  "memory",
] as const
export const JobType = Schema.Literals(jobTypes)
export type JobType = typeof JobType.Type
export const Profile = Schema.Literals([
  "auto",
  "fast",
  "balanced",
  "deep",
  "think-harder",
])
export type Profile = typeof Profile.Type
export const assignments: Record<JobType, ModelSettings> = {
  conversation: { model: "gpt-6.1-sol", thinking: "medium" },
  implementation: { model: "gpt-6.1-sol", thinking: "high" },
  planning: { model: "gpt-6-astra", thinking: "high" },
  review: { model: "gpt-6-astra", thinking: "high" },
  labels: { model: "gpt-6-luna", thinking: "low" },
  extraction: { model: "gpt-6-luna", thinking: "medium" },
  memory: { model: "gpt-6-luna", thinking: "medium" },
}
export const profiles: Record<Exclude<Profile, "auto">, ModelSettings> = {
  fast: assignments.labels,
  balanced: assignments.conversation,
  deep: assignments.planning,
  "think-harder": { model: "gpt-6-astra", thinking: "xhigh" },
}
export const ResolvedRoute = Schema.Struct({
  ...ModelSettings.fields,
  job: JobType,
  profile: Profile,
  policyVersion: Schema.String,
  reason: Schema.Literals([
    "explicit override",
    "agent setting",
    "application default",
    "active run",
    "legacy run",
  ]),
  contextWindow: Schema.optional(Schema.Number),
})
export type ResolvedRoute = typeof ResolvedRoute.Type
export function resolveRoute(
  job: JobType,
  agent?: ModelSettings,
  profile: Profile = "auto"
): ResolvedRoute {
  return {
    ...(profile === "auto" ? (agent ?? assignments[job]) : profiles[profile]),
    job,
    profile,
    policyVersion: POLICY_VERSION,
    reason:
      profile !== "auto"
        ? "explicit override"
        : agent
          ? "agent setting"
          : "application default",
  }
}
export const ModelCapability = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  thinking: Schema.Array(ThinkingLevel),
  input: Schema.Array(Schema.Literals(["text", "image"])),
  tools: Schema.Boolean,
  contextWindow: Schema.Number,
  unavailable: Schema.NullOr(Schema.String),
})
export type ModelCapability = typeof ModelCapability.Type
export const ModelCatalog = Schema.Struct({
  models: Schema.Array(ModelCapability),
  checkedAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  usage: Schema.Literal("ChatGPT plan usage"),
})
export type ModelCatalog = typeof ModelCatalog.Type
export class ModelUnavailable extends Schema.TaggedError<ModelUnavailable>()(
  "ModelUnavailable",
  { message: Schema.String }
) {}
export function validateRoute(
  route: ModelSettings,
  catalog: ModelCatalog,
  image = false,
  tools = true
) {
  const model = catalog.models.find((m) => m.id === route.model)
  const reason =
    catalog.error ??
    model?.unavailable ??
    (!model
      ? "This model is not available to the connected ChatGPT account."
      : !model.thinking.includes(route.thinking)
        ? "This model does not support the selected reasoning effort."
        : image && !model.input.includes("image")
          ? "This model cannot accept images."
          : tools && !model.tools
            ? "This model cannot use this agent's tools."
            : null)
  if (reason) throw new ModelUnavailable({ message: reason })
  return model!
}

export function pinnedRoute(
  source:
    | {
        routing?: ResolvedRoute | null
        model: string | null
        thinking: ModelSettings["thinking"] | null
      }
    | undefined,
  defaults: ModelSettings
): ResolvedRoute | undefined {
  if (!source) return undefined
  return (
    source.routing ?? {
      ...resolveRoute("conversation", {
        model: source.model ?? defaults.model,
        thinking: source.thinking ?? defaults.thinking,
      }),
      reason: "legacy run",
      policyVersion: "legacy",
    }
  )
}
