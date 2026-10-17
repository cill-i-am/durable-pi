import { Effect, Schema } from "effect"

import type { RemoteConnectionOperations } from "../../access/connection-service"
import type { RemoteToolResult } from "../../access/connections"
import { preserveFatal } from "../../shared/effect"
import { SkillBody, SkillConflict, SkillName } from "../contracts"
import {
  BrowseHostedSkills,
  HostedSkill,
  ReadHostedSkill,
  SkillSource,
  hostedSkillQuery,
} from "../source"
import { readSkillJson, skillResponse } from "./http"

type SkillProvider = Pick<RemoteConnectionOperations, "resolve" | "call">
const unavailable = () =>
  new SkillConflict({
    message:
      "This skills connection is unavailable or changed. Reload Connections and try again.",
  })

// Keep saved source revisions stable while accepting Executor's current name
// for the same pinned deployment identifier.
const ProviderSkill = Schema.Struct({
  ...HostedSkill.fields,
  deployment: Schema.optional(HostedSkill.fields.deployment),
  version: Schema.optional(HostedSkill.fields.deployment),
})
const versionPin = Schema.makeFilter<typeof ProviderSkill.Type>(
  ({ deployment, version }) =>
    (!!(version ?? deployment) &&
      (!version || !deployment || version === deployment)) ||
    "Use one consistent pinned skill version."
)
function pinnedSkill<T extends typeof ProviderSkill.Type>(skill: T) {
  const { version, ...value } = skill
  return { ...value, deployment: version ?? value.deployment! }
}

function providerJson(result: RemoteToolResult) {
  if (
    result.isError ||
    result.diagnostics?.some((item) => item.code === "durable_output_truncated")
  )
    throw new SkillConflict({
      message:
        "The provider could not return a complete skill. Try again with a narrower app selection.",
    })
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
  if (text.length > 200_000)
    throw new SkillConflict({
      message: "This provider response is too large. Nothing was imported.",
    })
  try {
    return JSON.parse(text) as unknown
  } catch (cause) {
    if (cause instanceof SyntaxError)
      throw new SkillConflict({
        message:
          "This provider returned an unsupported skill response. Nothing was imported.",
      })
    throw cause
  }
}

export function importSkillsRequest(
  provider: SkillProvider,
  request: Request,
  path: string
) {
  const resolve = (name: string) =>
    provider.resolve([name]).pipe(
      preserveFatal,
      Effect.catchTags({
        ConnectionError: () => Effect.fail(unavailable()),
        ConnectionTransportError: () => Effect.fail(unavailable()),
      }),
      Effect.flatMap((tools) =>
        tools[0]?.remoteName === "skills"
          ? Effect.succeed(tools[0])
          : Effect.fail(unavailable())
      )
    )
  const read = (name: string, args: Record<string, unknown>) =>
    provider.call(name, args).pipe(
      Effect.flatMap((result) =>
        Effect.try({
          try: () => providerJson(result),
          catch: (cause) => {
            const skillConflict =
              Schema.decodeUnknownOption(SkillConflict)(cause)
            if (skillConflict._tag === "Some") return skillConflict.value
            throw cause
          },
        })
      )
    )
  return skillResponse(
    Effect.gen(function* () {
      if (request.method !== "POST")
        return yield* new SkillConflict({
          message: "Use POST to preview hosted skills.",
        })
      const input = yield* readSkillJson(request)
      if (path === "skills/import/list") {
        const query =
          yield* Schema.decodeUnknownEffect(BrowseHostedSkills)(input)
        yield* resolve(query.toolName)
        const raw = yield* read(query.toolName, { app: query.app })
        const loaded = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            skills: Schema.Array(ProviderSkill.check(versionPin)).check(
              Schema.isMaxLength(100)
            ),
          })
        )(raw)
        const catalog = { skills: loaded.skills.map(pinnedSkill) }
        if (
          catalog.skills.some(
            (skill) =>
              skill.app.id !== query.app && skill.app.slug !== query.app
          )
        )
          return yield* new SkillConflict({
            message:
              "The provider returned skills for a different app. Nothing was imported.",
          })
        yield* resolve(query.toolName)
        return catalog
      }
      if (path === "skills/import/read") {
        const query = yield* Schema.decodeUnknownEffect(ReadHostedSkill)(input)
        const tool = yield* resolve(query.toolName)
        const raw = yield* read(query.toolName, {
          ...hostedSkillQuery(query.skill),
          file: "SKILL.md",
        })
        const loaded = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            ...ProviderSkill.fields,
            file: Schema.Literal("SKILL.md"),
            content: SkillBody,
            files: SkillSource.fields.files,
          }).check(versionPin)
        )(raw).pipe(
          Effect.map(pinnedSkill),
          Effect.mapError(
            () =>
              new SkillConflict({
                message:
                  "Use a complete SKILL.md of up to 16,000 characters with at most 100 reference files. Nothing was imported.",
              })
          )
        )
        if (
          JSON.stringify(hostedSkillQuery(loaded)) !==
          JSON.stringify(hostedSkillQuery(query.skill))
        )
          return yield* new SkillConflict({
            message:
              "The provider returned a different revision. Reload the catalog before importing.",
          })
        yield* resolve(query.toolName)
        const source = yield* Schema.decodeUnknownEffect(SkillSource)({
          ...query.skill,
          connectionId: tool.connectionId,
          connectionName: tool.connectionName,
          toolName: tool.name,
          files: loaded.files,
        }).pipe(
          Effect.mapError(
            () =>
              new SkillConflict({
                message:
                  "The source metadata exceeds 16 KB. Nothing was imported.",
              })
          )
        )
        return {
          name: Schema.decodeUnknownSync(SkillName)(loaded.name.slice(0, 80)),
          body: loaded.content,
          source,
        }
      }
      return yield* new SkillConflict({
        message: "Unknown skill import request.",
      })
    })
  )
}
