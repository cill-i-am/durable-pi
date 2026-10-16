import { pathToFileURL } from "node:url"
import { Config, Data, Effect, Redacted, Schema } from "effect"

class ObservabilitySetupFailed extends Data.TaggedError(
  "ObservabilitySetupFailed"
)<{
  operation: string
  status?: number
}> {}
const ResponseEnvelope = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.Unknown,
})
const Scripts = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    tags: Schema.optional(Schema.Array(Schema.String)),
  })
)
const Settings = Schema.Struct({
  observability: Schema.Record(Schema.String, Schema.Unknown),
})
const resources = [
  "AgentWorkerDrizzleV1",
  "Website",
  "DocumentWorker",
  "ExecutionWorker",
  "TerminalWorkerDrizzleV1",
]

export const configureObservability = Effect.gen(function* () {
  if (
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.GITHUB_EVENT_NAME !== "push"
  )
    return yield* new ObservabilitySetupFailed({
      operation: "main deployment guard",
    })
  const account = yield* Config.String("CLOUDFLARE_ACCOUNT_ID")
  const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN")
  const request = Effect.fn("Observability.configureIssues")(function* (
    path: string,
    body?: FormData
  ) {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(
          `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts${path}`,
          {
            method: body ? "PATCH" : "GET",
            signal,
            headers: { authorization: `Bearer ${Redacted.value(token)}` },
            body,
          }
        ),
      catch: () =>
        new ObservabilitySetupFailed({ operation: "Cloudflare request" }),
    })
    if (!response.ok)
      return yield* new ObservabilitySetupFailed({
        operation: "Cloudflare response",
        status: response.status,
      })
    const raw = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () =>
        new ObservabilitySetupFailed({ operation: "Cloudflare JSON" }),
    })
    const envelope = yield* Schema.decodeUnknownEffect(ResponseEnvelope)(raw)
    if (!envelope.success)
      return yield* new ObservabilitySetupFailed({
        operation: "Cloudflare rejected settings",
      })
    return envelope.result
  })
  const scripts = yield* request("").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Scripts))
  )
  const selected: string[] = []
  for (const resource of resources) {
    const matches = scripts.filter(
      ({ tags }) =>
        tags?.includes("alchemy:stack:durable-pi") &&
        tags.includes("alchemy:stage:production") &&
        tags.includes(`alchemy:id:${resource}`)
    )
    if (matches.length !== 1)
      return yield* new ObservabilitySetupFailed({
        operation: `resolve ${resource}`,
      })
    selected.push(matches[0]!.id)
  }
  for (const name of selected) {
    const settings = yield* request(`/${name}/settings`).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Settings))
    )
    const body = new FormData()
    body.set(
      "settings",
      new Blob(
        [
          JSON.stringify({
            observability: {
              ...settings.observability,
              issues: { enabled: true },
            },
          }),
        ],
        { type: "application/json" }
      )
    )
    yield* request(`/${name}/settings`, body)
    const verified = yield* request(`/${name}/settings`).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Settings))
    )
    yield* Schema.decodeUnknownEffect(
      Schema.Struct({ enabled: Schema.Literal(true) })
    )(verified.observability.issues)
    yield* Effect.logInfo("Workers Issues enabled", { worker: name })
  }
})
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await Effect.runPromise(
    configureObservability.pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.fail(
          new ObservabilitySetupFailed({
            operation: "Cloudflare response schema",
          })
        )
      )
    )
  )
