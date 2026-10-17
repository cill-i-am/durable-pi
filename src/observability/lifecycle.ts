import { channels } from "agents/observability"
import { Effect, Schema } from "effect"

import { OperationalLogger } from "./logger"

const Incident = Schema.Struct({
  type: Schema.Literals([
    "job:slow_dispatch",
    "job:backlog_warning",
    "alarm:memory_limit_reset",
  ]),
  agent: Schema.optional(Schema.String),
  payload: Schema.Struct({
    id: Schema.optional(Schema.String),
    capability: Schema.optional(Schema.String),
    thresholdMs: Schema.optional(Schema.Number),
    count: Schema.optional(Schema.Number),
    strikes: Schema.optional(Schema.Number),
    sealed: Schema.optional(Schema.Boolean),
  }),
})
export function lifecycleIncident(input: unknown) {
  return Schema.decodeUnknownOption(Incident)(input)
}
channels.lifecycle.subscribe((input: unknown) => {
  const incident = lifecycleIncident(input)
  if (incident._tag === "None") return
  const { type, agent, payload } = incident.value
  Effect.runSync(
    Effect.logError("Lifecycle.requiresAttention").pipe(
      Effect.annotateLogs({ event: type, agent, ...payload }),
      Effect.provide(OperationalLogger)
    )
  )
})
