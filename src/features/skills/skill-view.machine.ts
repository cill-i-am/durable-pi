import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { SaveSkill, Skill, SkillDocument, SkillId } from "@/skills/contracts"

import { skillsMessage } from "./skills.machine"

export const SkillDraft = Schema.Struct({
  ...SaveSkill.fields,
  name: Schema.String,
  body: Schema.String,
})
export type SkillDraft = typeof SkillDraft.Type
const FileValue = Schema.File
export type SkillViewWork = {
  file: (
    file: File,
    id: string
  ) => Effect.Effect<SkillDraft, unknown, Scope.Scope>
  versions: (
    id: string
  ) => Effect.Effect<readonly SkillDocument[], unknown, Scope.Scope>
  draft: (value: SkillDraft) => Effect.Effect<void>
}
export function skillViewMachine(work: SkillViewWork) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        generation: Schema.Int,
        file: Schema.NullOr(FileValue),
        id: Schema.String,
        skill: Schema.NullOr(Skill),
        versions: Schema.Array(SkillDocument),
        error: Schema.String,
        failure: Schema.UndefinedOr(Schema.Unknown),
      }),
      events: {
        EDIT: Schema.Struct({ draft: SkillDraft }),
        FILE: Schema.Struct({ file: FileValue, id: SkillId }),
        HISTORY: Schema.Struct({ skill: Skill }),
        HOSTED: Schema.Struct({}),
        CANCEL: Schema.Struct({}),
        LEAVE: Schema.Struct({}),
        SAVED: Schema.Struct({ generation: Schema.Int }),
        CLEAR_ERROR: Schema.Struct({}),
      },
    },
    actors: {
      file: createEffectLogic(
        ({ input }: { input: { file: File; id: string } }) =>
          Effect.exit(work.file(input.file, input.id))
      ),
      versions: createEffectLogic(({ input }: { input: string }) =>
        Effect.exit(work.versions(input))
      ),
    },
    actions: {
      draft: ({ params }: { params?: unknown }) =>
        work.draft(Schema.decodeUnknownSync(SkillDraft)(params)),
    },
  }).createMachine({
    id: "skill-view",
    initial: "library",
    context: {
      generation: 0,
      file: null,
      id: "",
      skill: null,
      versions: [],
      error: "",
      failure: undefined,
    },
    on: {
      EDIT: (args, enq) => {
        enq(args.actions.draft, { ...args, params: args.event.draft })
        return {
          target: ".editing",
          context: {
            ...args.context,
            generation: args.context.generation + 1,
            error: "",
            failure: undefined,
          },
        }
      },
      FILE: ({ context, event }) =>
        event.file.size > 64000
          ? {
              target: ".library",
              context: {
                ...context,
                error:
                  "Choose a Markdown file up to 64 KB and 16,000 characters.",
              },
            }
          : {
              target: ".readingFile",
              reenter: true,
              context: {
                ...context,
                file: event.file,
                id: event.id,
                generation: context.generation + 1,
                error: "",
                failure: undefined,
              },
            },
      HISTORY: ({ context, event }) => ({
        target: ".readingHistory",
        reenter: true,
        context: {
          ...context,
          skill: event.skill,
          generation: context.generation + 1,
          error: "",
          failure: undefined,
        },
      }),
      HOSTED: ({ context }) => ({
        target: ".hosted",
        context: { ...context, generation: context.generation + 1, error: "" },
      }),
      CANCEL: ({ context }) => ({
        target: ".library",
        context: { ...context, generation: context.generation + 1, error: "" },
      }),
      LEAVE: ({ context }) => ({
        target: ".library",
        context: { ...context, generation: context.generation + 1, error: "" },
      }),
      CLEAR_ERROR: ({ context }) => ({ context: { ...context, error: "" } }),
    },
    states: {
      library: {},
      editing: {
        on: {
          LEAVE: {},
          SAVED: ({ context, event }) =>
            event.generation === context.generation
              ? { target: "library" }
              : undefined,
        },
      },
      hosted: {},
      history: {},
      readingFile: {
        invoke: {
          src: "file",
          input: ({ context }) => ({ file: context.file!, id: context.id }),
          onDone: (args, enq) => {
            if (Exit.isFailure(args.event.output))
              return {
                target: "library",
                context: {
                  ...args.context,
                  error: skillsMessage(
                    args.event.output.cause,
                    "Could not read this file."
                  ),
                  failure: args.event.output.cause,
                },
              }
            enq(args.actions.draft, {
              ...args,
              params: args.event.output.value,
            })
            return { target: "editing" }
          },
        },
      },
      readingHistory: {
        invoke: {
          src: "versions",
          input: ({ context }) => context.skill!.id,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "library",
                  context: {
                    ...context,
                    error: "Could not load revision history.",
                    failure: event.output.cause,
                  },
                }
              : {
                  target: "history",
                  context: { ...context, versions: event.output.value },
                },
        },
      },
    },
  })
}
