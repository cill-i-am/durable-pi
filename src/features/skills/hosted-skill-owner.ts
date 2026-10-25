import { Effect, Schema } from "effect"

import { ConnectionList } from "@/access/connections"
import { SkillBody, SkillName } from "@/skills/contracts"
import { HostedSkillCatalog, SkillSource } from "@/skills/source"

import {
  hostedSkillIdentity,
  type HostedSkillWork,
} from "./hosted-skill.machine"
import { skillRequest } from "./skills-owner"

const Preview = Schema.Struct({
  name: SkillName,
  body: SkillBody,
  source: SkillSource,
})
export const hostedSkillRequests: HostedSkillWork = {
  providers: () =>
    skillRequest("home", "connections").pipe(
      Effect.map(Schema.decodeUnknownSync(ConnectionList)),
      Effect.map((result) =>
        result.connections
          .filter((connection) => connection.status === "ready")
          .flatMap((connection) =>
            connection.tools.filter((tool) => tool.remoteName === "skills")
          )
      )
    ),
  browse: (input) =>
    skillRequest("home", "skills/import/list", input).pipe(
      Effect.map(Schema.decodeUnknownSync(HostedSkillCatalog)),
      Effect.map((result) => result.skills)
    ),
  read: ({ id, ...input }) =>
    skillRequest("home", "skills/import/read", input).pipe(
      Effect.map(
        Schema.decodeUnknownSync(
          Preview.check(
            Schema.makeFilter(
              (value) =>
                (value.source.toolName === input.toolName &&
                  hostedSkillIdentity(value.source) ===
                    hostedSkillIdentity(input.skill)) ||
                "The preview belongs to a different skill revision."
            )
          )
        )
      ),
      Effect.map((value) => ({ id, expectedRevision: 0, ...value }))
    ),
}
