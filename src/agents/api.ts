import { Schema } from "effect"
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/http-api"
import { AgentProfile } from "./domain"

export const AgentCatalogResponse = Schema.Struct({
  agents: Schema.Array(AgentProfile),
})
export const AgentCatalogReadRejected = Schema.Struct({
  error: Schema.Literal(
    "The request could not be completed. Your saved messages are safe."
  ),
})
export class AgentQueries extends HttpApiGroup.make("agents").add(
  HttpApiEndpoint.get("list", "/api/agent/bots", {
    success: AgentCatalogResponse,
    error: AgentCatalogReadRejected.pipe(HttpApiSchema.status(400)),
  })
) {}
/** Describes the existing JSON read boundary. The outer gateway owns identity. */
export class AgentQueryApi extends HttpApi.make("AgentQueries").add(
  AgentQueries
) {}
