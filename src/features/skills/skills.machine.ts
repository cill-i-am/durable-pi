import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import {
  ArchiveSkill,
  SaveSkill,
  SelectSkills,
  Skill,
  SkillLibrary,
  SkillSelection,
} from "@/skills/contracts"

export const SkillCommand = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("save"), input: SaveSkill }),
  Schema.Struct({ kind: Schema.Literal("archive"), input: ArchiveSkill }),
  Schema.Struct({ kind: Schema.Literal("select"), input: SelectSkills }),
])
export type SkillCommand = typeof SkillCommand.Type
const Request = Schema.Struct({ id: Schema.String, command: SkillCommand })
const Loaded = Schema.Struct({
  library: SkillLibrary.fields.skills,
  selection: SkillSelection,
})
export type SkillsWork = {
  read: () => Effect.Effect<typeof Loaded.Type, unknown, Scope.Scope>
  command: (
    request: SkillCommand
  ) => Effect.Effect<Skill | SkillSelection, unknown, Scope.Scope>
}
const context = Schema.Struct({
  agentId: Schema.UndefinedOr(Schema.String),
  library: SkillLibrary.fields.skills,
  selection: SkillSelection,
  ready: Schema.Boolean,
  dirty: Schema.Boolean,
  request: Schema.NullOr(Request),
  failed: Schema.NullOr(SkillCommand),
  error: Schema.String,
  failure: Schema.UndefinedOr(Schema.Unknown),
})
export const skillsMessage = (
  cause: Cause.Cause<unknown>,
  fallback: string
) => {
  const reason = cause.reasons.find((value) => value._tag === "Fail")
  return reason?._tag === "Fail" &&
    Schema.is(Schema.Struct({ message: Schema.String }))(reason.error)
    ? reason.error.message
    : fallback
}
/** Library observation never repeats a mutation; commands capture immutable CAS input. */
export function skillsMachine(work: SkillsWork) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: Schema.UndefinedOr(Schema.String),
      context,
      events: { REFRESH: Schema.Struct({}), COMMAND: Request },
      emitted: {
        settled: Schema.Struct({
          id: Schema.String,
          result: Schema.UndefinedOr(Schema.Union([Skill, SkillSelection])),
        }),
      },
    },
    actors: {
      read: createEffectLogic(() => Effect.exit(work.read())),
      command: createEffectLogic(({ input }: { input: SkillCommand }) =>
        Effect.exit(work.command(input))
      ),
    },
  }).createMachine({
    id: "skills-ui",
    type: "parallel",
    context: ({ input }) => ({
      agentId: input,
      library: [],
      selection: { revision: 0, skills: [] },
      ready: false,
      dirty: false,
      request: null,
      failed: null,
      error: "",
      failure: undefined,
    }),
    states: {
      resource: {
        initial: "idle",
        on: {
          REFRESH: ({ context }) => ({
            target: context.request ? ".paused" : ".loading",
            context: { ...context, dirty: !!context.request, error: "" },
          }),
        },
        states: {
          idle: {},
          loading: {
            on: {
              REFRESH: ({ context }) => ({
                context: { ...context, dirty: true, error: "" },
              }),
            },
            invoke: {
              src: "read",
              onDone: ({ context, event }) => {
                // An invalidated read keeps its native scope until settlement.
                // Only then may one queued observation follow the command.
                if (context.dirty)
                  return {
                    target: context.request ? "paused" : "loading",
                    reenter: true,
                    context: { ...context, dirty: !!context.request },
                  }
                return Exit.isFailure(event.output)
                  ? {
                      target: "idle",
                      context: {
                        ...context,
                        dirty: false,
                        error: skillsMessage(
                          event.output.cause,
                          "Could not load skills."
                        ),
                        failure: event.output.cause,
                      },
                    }
                  : {
                      target: "idle",
                      context: {
                        ...context,
                        dirty: false,
                        ready: true,
                        library: event.output.value.library.map((skill) => {
                          const old = context.library.find(
                            (value) => value.id === skill.id
                          )
                          return old && old.stateRevision > skill.stateRevision
                            ? old
                            : skill
                        }),
                        selection:
                          context.selection.revision >
                          event.output.value.selection.revision
                            ? context.selection
                            : event.output.value.selection,
                        error: "",
                      },
                    }
              },
            },
          },
          paused: {
            always: ({ context }) =>
              !context.request
                ? {
                    target: context.dirty ? "loading" : "idle",
                    context: { ...context, dirty: false },
                  }
                : undefined,
          },
        },
      },
      command: {
        initial: "ready",
        states: {
          ready: {
            on: {
              COMMAND: ({ context, event }, enq) => {
                if (
                  (event.command.kind === "select") !==
                  (context.agentId !== undefined)
                ) {
                  enq.emit({ type: "settled", id: event.id, result: undefined })
                  return
                }
                return {
                  target: "requesting",
                  context: {
                    ...context,
                    request: event,
                    dirty: true,
                    failed: null,
                    error: "",
                    failure: undefined,
                  },
                }
              },
            },
          },
          requesting: {
            on: {
              COMMAND: ({ event }, enq) => {
                enq.emit({ type: "settled", id: event.id, result: undefined })
              },
            },
            invoke: {
              src: "command",
              input: ({ context }) => context.request!.command,
              onDone: ({ context, event }, enq) => {
                const request = context.request!
                if (Exit.isFailure(event.output)) {
                  enq.emit({
                    type: "settled",
                    id: request.id,
                    result: undefined,
                  })
                  return {
                    target: "ready",
                    context: {
                      ...context,
                      request: null,
                      failed: request.command,
                      error: skillsMessage(
                        event.output.cause,
                        "The update was not confirmed. Reload to review the saved state or retry the same change."
                      ),
                      failure: event.output.cause,
                    },
                  }
                }
                const value = event.output.value
                enq.emit({ type: "settled", id: request.id, result: value })
                return {
                  target: "ready",
                  context: {
                    ...context,
                    request: null,
                    failed: null,
                    error: "",
                    failure: undefined,
                    ...("skills" in value
                      ? { selection: value }
                      : {
                          library: [
                            value,
                            ...context.library.filter(
                              (skill) => skill.id !== value.id
                            ),
                          ],
                        }),
                  },
                }
              },
            },
          },
        },
      },
    },
  })
}
