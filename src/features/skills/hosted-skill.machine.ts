import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { RemoteTool } from "@/access/connections"
import { SaveSkill, SkillId } from "@/skills/contracts"
import {
  BrowseHostedSkills,
  HostedSkill,
  ReadHostedSkill,
} from "@/skills/source"

import { skillsMessage } from "./skills.machine"

const ReadRequest = Schema.Struct({ ...ReadHostedSkill.fields, id: SkillId })
export type HostedSkillWork = {
  providers: () => Effect.Effect<readonly RemoteTool[], unknown, Scope.Scope>
  browse: (
    input: typeof BrowseHostedSkills.Type
  ) => Effect.Effect<readonly HostedSkill[], unknown, Scope.Scope>
  read: (
    input: typeof ReadRequest.Type
  ) => Effect.Effect<SaveSkill, unknown, Scope.Scope>
}
export const hostedSkillIdentity = (skill: HostedSkill) =>
  JSON.stringify([
    skill.name,
    skill.app.id,
    skill.app.slug,
    skill.deployment,
    skill.revision,
    skill.profile,
    skill.profileRevision,
  ])
/** One import owns its pinned provider/revision until preview or explicit close. */
export function hostedSkillMachine(work: HostedSkillWork) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        providers: Schema.Array(RemoteTool),
        selected: Schema.String,
        catalog: Schema.NullOr(Schema.Array(HostedSkill)),
        browse: Schema.NullOr(BrowseHostedSkills),
        read: Schema.NullOr(ReadRequest),
        error: Schema.String,
        failure: Schema.UndefinedOr(Schema.Unknown),
      }),
      events: {
        PROVIDER: Schema.Struct({ name: Schema.String }),
        CLEAR_CATALOG: Schema.Struct({}),
        BROWSE: Schema.Struct({ app: Schema.String }),
        READ: Schema.Struct({ skill: HostedSkill, id: SkillId }),
        CANCEL: Schema.Struct({}),
      },
      emitted: { preview: Schema.Struct({ draft: SaveSkill }) },
    },
    actors: {
      providers: createEffectLogic(() => Effect.exit(work.providers())),
      browse: createEffectLogic(
        ({ input }: { input: typeof BrowseHostedSkills.Type }) =>
          Effect.exit(work.browse(input))
      ),
      read: createEffectLogic(({ input }: { input: typeof ReadRequest.Type }) =>
        Effect.exit(work.read(input))
      ),
    },
  }).createMachine({
    id: "hosted-skill-ui",
    initial: "providers",
    context: {
      providers: [],
      selected: "",
      catalog: null,
      browse: null,
      read: null,
      error: "",
      failure: undefined,
    },
    on: { CANCEL: { target: ".closed" } },
    states: {
      providers: {
        invoke: {
          src: "providers",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "ready",
                  context: {
                    ...context,
                    error:
                      "Could not load your connections. Close this import and retry.",
                    failure: event.output.cause,
                  },
                }
              : {
                  target: "ready",
                  context: {
                    ...context,
                    providers: event.output.value,
                    selected: event.output.value[0]?.name ?? "",
                  },
                },
        },
      },
      ready: {
        on: {
          PROVIDER: ({ context, event }) =>
            context.providers.some((tool) => tool.name === event.name)
              ? {
                  context: {
                    ...context,
                    selected: event.name,
                    catalog: null,
                    error: "",
                  },
                }
              : undefined,
          CLEAR_CATALOG: ({ context }) => ({
            context: { ...context, catalog: null },
          }),
          BROWSE: ({ context, event }) => {
            if (!/^[a-zA-Z0-9_.-]{1,160}$/.test(event.app))
              return {
                context: {
                  ...context,
                  error:
                    "Use an app slug containing letters, numbers, dots, dashes or underscores.",
                },
              }
            return context.selected
              ? {
                  target: "browsing",
                  context: {
                    ...context,
                    browse: { toolName: context.selected, app: event.app },
                    error: "",
                    failure: undefined,
                  },
                }
              : undefined
          },
          READ: ({ context, event }) =>
            context.catalog?.some(
              (skill) =>
                hostedSkillIdentity(skill) === hostedSkillIdentity(event.skill)
            )
              ? {
                  target: "reading",
                  context: {
                    ...context,
                    read: {
                      toolName: context.selected,
                      skill: event.skill,
                      id: event.id,
                    },
                    error: "",
                    failure: undefined,
                  },
                }
              : undefined,
        },
      },
      browsing: {
        invoke: {
          src: "browse",
          input: ({ context }) => context.browse!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "ready",
                  context: {
                    ...context,
                    error: skillsMessage(
                      event.output.cause,
                      "Could not browse skills. Nothing was saved."
                    ),
                    failure: event.output.cause,
                  },
                }
              : {
                  target: "ready",
                  context: { ...context, catalog: event.output.value },
                },
        },
      },
      reading: {
        invoke: {
          src: "read",
          input: ({ context }) => context.read!,
          onDone: ({ context, event }, enq) => {
            if (Exit.isFailure(event.output))
              return {
                target: "ready",
                context: {
                  ...context,
                  error: skillsMessage(
                    event.output.cause,
                    "Could not read this skill. Nothing was saved."
                  ),
                  failure: event.output.cause,
                },
              }
            enq.emit({ type: "preview", draft: event.output.value })
            return { target: "previewed" }
          },
        },
      },
      previewed: {},
      closed: { type: "final" },
    },
  })
}
