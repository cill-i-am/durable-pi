import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api"

import { ModelSelection } from "../conversations/turns"
import { ModelCatalog, ResolvedRoute } from "./policy"

export const ModelCatalogResponse = Schema.Struct({
  ...ModelCatalog.fields,
  selection: ModelSelection,
  assignments: Schema.Record(Schema.String, ResolvedRoute),
})
export type ModelCatalogResponse = typeof ModelCatalogResponse.Type
export class ModelQueries extends HttpApiGroup.make("models").add(
  HttpApiEndpoint.get("read", "/api/agent/models", {
    query: Schema.Struct({ agent: Schema.String }),
    success: ModelCatalogResponse,
  })
) {}
/** The existing authenticated gateway remains the authority for this read. */
export class ModelQueryApi extends HttpApi.make("ModelQueries").add(
  ModelQueries
) {}

export const newestModelCatalog = (
  previous: ModelCatalogResponse | undefined,
  next: ModelCatalogResponse
) =>
  previous &&
  previous.selection.settingsRevision > next.selection.settingsRevision
    ? {
        ...next,
        selection: previous.selection,
        assignments: previous.assignments,
      }
    : next
