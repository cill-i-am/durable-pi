import { Schema } from "effect"

export const AppId = Schema.String.check(
  Schema.isPattern(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
  )
)
export const ComponentId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9_-]{0,39}$/),
  Schema.makeFilter(
    (id) => !["constructor", "prototype", "__proto__"].includes(id)
  )
)
const text = (max: number) => Schema.String.check(Schema.isMaxLength(max))
const label = text(200).check(Schema.isMinLength(1), Schema.isPattern(/\S/))
export const Revision = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
)
export const WebState = text(8000).check(
  Schema.makeFilter((value) => {
    try {
      JSON.parse(value)
      return true
    } catch {
      return false
    }
  })
)
export const WebResult = Schema.Struct({
  html: text(12000),
  css: text(4000),
  state: WebState,
  summary: text(1000),
})
export type WebResult = typeof WebResult.Type
export const AppBlock = Schema.Union([
  Schema.Struct({
    id: ComponentId,
    type: Schema.Literal("web"),
    code: text(16000).check(Schema.isMinLength(1)),
    initialState: WebState,
  }),
  Schema.Struct({
    id: ComponentId,
    type: Schema.Literal("text"),
    text: text(4000),
  }),
  Schema.Struct({
    id: ComponentId,
    type: Schema.Literal("metric"),
    label,
    value: text(120),
  }),
  Schema.Struct({
    id: ComponentId,
    type: Schema.Literal("table"),
    title: label,
    columns: Schema.Array(label).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(6)
    ),
    rows: Schema.Array(
      Schema.Array(text(500)).check(Schema.isMaxLength(6))
    ).check(Schema.isMaxLength(40)),
  }),
  Schema.Struct({
    id: ComponentId,
    type: Schema.Literal("checklist"),
    title: label,
    items: Schema.Array(Schema.Struct({ id: ComponentId, label })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(40)
    ),
  }),
  Schema.Struct({
    id: ComponentId,
    type: Schema.Literal("form"),
    title: label,
    submitLabel: label,
    fields: Schema.Array(
      Schema.Struct({
        id: ComponentId,
        label,
        required: Schema.Boolean,
        multiline: Schema.Boolean,
      })
    ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  }),
])
export type AppBlock = typeof AppBlock.Type
export const AppDefinition = Schema.Struct({
  title: text(80).check(Schema.isMinLength(1), Schema.isPattern(/\S/)),
  description: text(500),
  blocks: Schema.Array(AppBlock).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20)
  ),
}).check(
  Schema.makeFilter((definition) => {
    if (JSON.stringify(definition).length > 24000) return false
    if (
      definition.blocks.some((block) => block.type === "web") &&
      definition.blocks.length !== 1
    )
      return false
    if (
      new Set(definition.blocks.map((block) => block.id)).size !==
      definition.blocks.length
    )
      return false
    return definition.blocks.every((block) => {
      if (block.type === "table")
        return block.rows.every((row) => row.length === block.columns.length)
      const entries =
        block.type === "form"
          ? block.fields
          : block.type === "checklist"
            ? block.items
            : []
      return new Set(entries.map((entry) => entry.id)).size === entries.length
    })
  })
)
export type AppDefinition = typeof AppDefinition.Type
export const AppState = Schema.Struct({
  checks: Schema.Record(Schema.String, Schema.Boolean),
  forms: Schema.Record(ComponentId, Schema.Record(ComponentId, text(1000))),
  web: Schema.optionalKey(Schema.Record(ComponentId, WebState)),
})
export type AppState = typeof AppState.Type
export const AppVersion = Schema.Struct({
  id: AppId,
  version: Revision,
  definition: AppDefinition,
  createdAt: Schema.String,
})
export type AppVersion = typeof AppVersion.Type
export const AppDocument = Schema.Struct({
  ...AppVersion.fields,
  revision: Revision,
  publishedVersion: Schema.NullOr(Revision),
  archived: Schema.Boolean,
  state: AppState,
})
export type AppDocument = typeof AppDocument.Type
export const AppList = Schema.Struct({ apps: Schema.Array(AppDocument) })
export const SaveApp = Schema.Struct({
  operationId: AppId,
  id: AppId,
  expectedRevision: Revision,
  definition: AppDefinition,
})
export type SaveApp = typeof SaveApp.Type
export const PublishApp = Schema.Struct({
  operationId: AppId,
  id: AppId,
  expectedRevision: Revision,
  version: Revision,
})
export type PublishApp = typeof PublishApp.Type
export const ArchiveApp = Schema.Struct({
  operationId: AppId,
  id: AppId,
  expectedRevision: Revision,
  archived: Schema.Boolean,
})
export type ArchiveApp = typeof ArchiveApp.Type
export const AppAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("web"),
    blockId: ComponentId,
    name: ComponentId,
    values: Schema.Record(ComponentId, text(1000)).check(
      Schema.makeFilter((values) => Object.keys(values).length <= 8)
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("check"),
    blockId: ComponentId,
    itemId: ComponentId,
    checked: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("submit"),
    blockId: ComponentId,
    values: Schema.Record(ComponentId, text(1000)),
  }),
])
export type AppAction = typeof AppAction.Type
export const InteractApp = Schema.Struct({
  operationId: AppId,
  id: AppId,
  expectedRevision: Revision,
  version: Revision,
  action: AppAction,
})
export type InteractApp = typeof InteractApp.Type
export const AppEvent = Schema.Struct({
  id: AppId,
  appId: AppId,
  turnId: AppId,
  version: Revision,
  text: text(16000),
  createdAt: Schema.String,
  delivery: Schema.Literals(["pending", "queued"]),
})
export type AppEvent = typeof AppEvent.Type
export const AppDetail = Schema.Struct({
  app: AppDocument,
  versions: Schema.Array(AppVersion),
  events: Schema.Array(AppEvent),
})
export type AppDetail = typeof AppDetail.Type
export class AppConflict extends Schema.TaggedError<AppConflict>()(
  "AppConflict",
  { message: Schema.String }
) {}

export const RenderWebApp = Schema.Struct({ id: AppId, version: Revision })
export const WebPreview = Schema.Struct({
  id: AppId,
  version: Revision,
  revision: Revision,
  html: text(64000),
  css: text(4000),
})
export type WebPreview = typeof WebPreview.Type
