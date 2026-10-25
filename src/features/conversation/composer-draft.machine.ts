import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Deferred, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { ComposerDraft } from "./composer-draft"

export type DraftChange = (draft: ComposerDraft) => Partial<ComposerDraft>
const reply = Schema.declare((value): value is Deferred.Deferred<boolean> =>
  Deferred.isDeferred(value)
)
const change = Schema.declare(
  (value): value is DraftChange => typeof value === "function"
)
const pending = Schema.Struct({ revision: Schema.Number, reply })
const input = Schema.Struct({
  draft: ComposerDraft,
  unreadable: Schema.Boolean,
})
const context = Schema.Struct({
  ...input.fields,
  revision: Schema.Number,
  pending: Schema.Array(pending),
  failure: Schema.Unknown,
})
type Context = typeof context.Type
const edited = (
  context: Context,
  event: { change: DraftChange; reply: Deferred.Deferred<boolean> }
) => ({
  ...context,
  draft: Schema.decodeUnknownSync(ComposerDraft)({
    ...context.draft,
    ...event.change(context.draft),
  }),
  revision: context.revision + 1,
  pending: [
    ...context.pending,
    { revision: context.revision + 1, reply: event.reply },
  ],
})

/** Saves serialize behind the current write. A failed restore never authorizes
 * replacing the unreadable record; edits stay in memory and keep reload blocked. */
export function composerDraftMachine(
  write: (draft: ComposerDraft) => Effect.Effect<void, unknown>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input,
      context,
      events: { CHANGE: Schema.Struct({ change, reply }) },
    },
    actors: {
      write: createEffectLogic(
        ({ input }: { input: { draft: ComposerDraft; revision: number } }) =>
          Effect.exit(write(input.draft)).pipe(
            Effect.map((exit) => ({
              revision: input.revision,
              saved: Exit.isSuccess(exit),
              failure: Exit.isFailure(exit) ? exit.cause : undefined,
            }))
          )
      ),
    },
    actions: {
      answer: ({ params }: { params?: unknown }) => {
        const value = Schema.decodeUnknownSync(
          Schema.Struct({
            pending: Schema.Array(pending),
            saved: Schema.Boolean,
          })
        )(params)
        return Effect.forEach(
          value.pending,
          ({ reply }) => Deferred.succeed(reply, value.saved),
          { discard: true }
        )
      },
    },
  }).createMachine({
    id: "composer-draft",
    context: ({ input }) => ({
      ...input,
      revision: 0,
      pending: [],
      failure: undefined,
    }),
    initial: "restored",
    states: {
      restored: {
        always: ({ context }) => ({
          target: context.unreadable ? "unreadable" : "saved",
        }),
      },
      saved: {
        on: {
          CHANGE: ({ context, event }) => ({
            target: "saving",
            context: edited(context, event),
          }),
        },
      },
      unsaved: {
        on: {
          CHANGE: ({ context, event }) => ({
            target: "saving",
            context: edited(context, event),
          }),
        },
      },
      unreadable: {
        on: {
          CHANGE: (args, enq) => {
            enq(args.actions.answer, {
              ...args,
              params: {
                pending: [
                  { revision: args.context.revision, reply: args.event.reply },
                ],
                saved: false,
              },
            })
            return {
              context: { ...edited(args.context, args.event), pending: [] },
            }
          },
        },
      },
      saving: {
        on: {
          CHANGE: ({ context, event }) => ({ context: edited(context, event) }),
        },
        invoke: {
          src: "write",
          input: ({ context }) => context,
          onDone: (args, enq) => {
            const { context, event } = args
            enq(args.actions.answer, {
              ...args,
              params: {
                pending: context.pending.filter(
                  (value) => value.revision <= event.output.revision
                ),
                saved: event.output.saved,
              },
            })
            return {
              target:
                event.output.revision < context.revision
                  ? "saving"
                  : event.output.saved
                    ? "saved"
                    : "unsaved",
              reenter: true,
              context: {
                ...context,
                failure: event.output.failure,
                pending: context.pending.filter(
                  (value) => value.revision > event.output.revision
                ),
              },
            }
          },
        },
      },
    },
  })
}
