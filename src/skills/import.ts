import { Effect, Schema } from "effect"
import type { ToolExecutionResult } from "@earendil-works/pi-durable"
import type { RemoteConnections } from "../access/adapters/mcp"
import { SkillBody, SkillConflict, SkillName } from "./contracts"
import {
  BrowseHostedSkills,
  HostedSkill,
  HostedSkillCatalog,
  ReadHostedSkill,
  SkillSource,
  hostedSkillQuery,
} from "./source"
import { readSkillJson, skillResponse } from "./http"

type SkillProvider = Pick<RemoteConnections, "resolve" | "call">
const unavailable = () =>
  new SkillConflict({
    message:
      "This skills connection is unavailable or changed. Reload Connections and try again.",
  })

function providerJson(result: ToolExecutionResult) {
  if (
    result.isError ||
    result.diagnostics?.some((item) => item.code === "durable_output_truncated")
  )
    throw new SkillConflict({
      message:
        "The provider could not return a complete skill. Try again with a narrower app selection.",
    })
  const text = (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
  if (text.length > 200_000) throw new Error("Oversized provider response")
  return JSON.parse(text) as unknown
}

export function importSkillsRequest(
  provider: SkillProvider,
  request: Request,
  path: string
) {
  const resolve = (name: string) =>
    Effect.tryPromise({
      try: async () => {
        const result = await provider.resolve([name])
        const tool = result.tools[0]
        if (result.error || !tool || tool.remoteName !== "skills")
          throw unavailable()
        return tool
      },
      catch: unavailable,
    })
  const read = (name: string, args: Record<string, unknown>) =>
    Effect.tryPromise({
      try: async () => providerJson(await provider.call(name, args)),
      catch: (cause) =>
        cause instanceof SkillConflict
          ? cause
          : new SkillConflict({
              message:
                "This provider returned an unsupported skill response. Nothing was imported.",
            }),
    })
  return skillResponse(
    Effect.gen(function* () {
      if (request.method !== "POST")
        return yield* new SkillConflict({
          message: "Use POST to preview hosted skills.",
        })
      const input = yield* readSkillJson(request)
      if (path === "skills/import/list") {
        const query = yield* Effect.try(() =>
          Schema.decodeUnknownSync(BrowseHostedSkills)(input)
        )
        yield* resolve(query.toolName)
        const raw = yield* read(query.toolName, { app: query.app })
        const catalog = yield* Effect.try(() =>
          Schema.decodeUnknownSync(HostedSkillCatalog)(raw)
        )
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
        const query = yield* Effect.try(() =>
          Schema.decodeUnknownSync(ReadHostedSkill)(input)
        )
        const tool = yield* resolve(query.toolName)
        const raw = yield* read(query.toolName, {
          ...hostedSkillQuery(query.skill),
          file: "SKILL.md",
        })
        const loaded = yield* Effect.try(() =>
          Schema.decodeUnknownSync(
            Schema.Struct({
              ...HostedSkill.fields,
              file: Schema.Literal("SKILL.md"),
              content: SkillBody,
              files: SkillSource.fields.files,
            })
          )(raw)
        ).pipe(
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
        const source = yield* Effect.try(() =>
          Schema.decodeUnknownSync(SkillSource)({
            ...query.skill,
            connectionId: tool.connectionId,
            connectionName: tool.connectionName,
            toolName: tool.name,
            files: loaded.files,
          })
        ).pipe(
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
