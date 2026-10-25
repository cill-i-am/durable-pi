import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Deferred, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { SendInput } from "@/conversations/contracts"
import { type Submission } from "@/conversations/turns"
import { Profile, JobType } from "@/inference/policy"

import { submissionAttempt, rejectedModelAttempt } from "./commands"

const reply = Schema.declare((value): value is Deferred.Deferred<boolean> =>
  Deferred.isDeferred(value)
)
export const SubmissionRequest = Schema.Struct({
  text: Schema.String,
  mode: Schema.Literals(["followUp", "steer"]),
  files: Schema.Array(Schema.String),
  profile: Profile,
  job: JobType,
})
export type SubmissionRequest = typeof SubmissionRequest.Type
const context = Schema.Struct({
  pending: Schema.NullOr(SendInput),
  reply: Schema.NullOr(reply),
  error: Schema.String,
  accepted: Schema.Boolean,
  failure: Schema.Unknown,
})

/** Explicit submission only. The persisted attempt must exist before dispatch;
 * uncertainty retains its identity and never schedules another request. */
export function submissionMachine(work: {
  persist: (attempt: Submission) => Effect.Effect<boolean, unknown>
  send: (attempt: Submission) => Effect.Effect<void, unknown>
  acknowledge: (attempt: Submission) => Effect.Effect<void, unknown>
  rejectModel: (attempt: Submission) => Effect.Effect<void, unknown>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: Schema.NullOr(SendInput),
      context,
      events: {
        SUBMIT: Schema.Struct({ ...SubmissionRequest.fields, reply }),
        CLEAR_ERROR: Schema.Struct({}),
      },
    },
    actors: {
      persist: createEffectLogic(({ input }: { input: Submission }) =>
        Effect.exit(work.persist(input))
      ),
      send: createEffectLogic(({ input }: { input: Submission }) =>
        Effect.exit(work.send(input))
      ),
      acknowledge: createEffectLogic(({ input }: { input: Submission }) =>
        Effect.exit(work.acknowledge(input))
      ),
      rejectModel: createEffectLogic(({ input }: { input: Submission }) =>
        Effect.exit(work.rejectModel(input))
      ),
      answer: createEffectLogic(
        ({
          input,
        }: {
          input: { reply: Deferred.Deferred<boolean>; accepted: boolean }
        }) => Deferred.succeed(input.reply, input.accepted)
      ),
    },
    actions: {
      decline: ({ params }: { params?: unknown }) =>
        Deferred.succeed(Schema.decodeUnknownSync(reply)(params), false),
    },
  }).createMachine({
    id: "conversation-submission",
    initial: "ready",
    context: ({ input }) => ({
      pending: input,
      reply: null,
      error: "",
      accepted: false,
      failure: undefined,
    }),
    on: {
      CLEAR_ERROR: ({ context }) => ({ context: { ...context, error: "" } }),
      SUBMIT: (args, enq) => {
        enq(args.actions.decline, { ...args, params: args.event.reply })
      },
    },
    states: {
      ready: {
        on: {
          SUBMIT: ({ context, event }) => ({
            target: "persisting",
            context: {
              ...context,
              pending: submissionAttempt(
                context.pending,
                event.text,
                event.mode,
                event.files,
                event.profile,
                event.job
              ),
              reply: event.reply,
              accepted: false,
              error: "",
              failure: undefined,
            },
          }),
        },
      },
      persisting: {
        invoke: {
          src: "persist",
          input: ({ context }) => context.pending!,
          onDone: ({ context, event }) =>
            Exit.isSuccess(event.output) && event.output.value
              ? { target: "sending" }
              : {
                  target: "answering",
                  context: {
                    ...context,
                    error:
                      "Your draft could not be saved. Keep this tab open and try again.",
                    failure: Exit.isFailure(event.output)
                      ? event.output.cause
                      : undefined,
                  },
                },
        },
      },
      sending: {
        invoke: {
          src: "send",
          input: ({ context }) => context.pending!,
          onDone: ({ context, event }) => {
            if (Exit.isSuccess(event.output))
              return {
                target: "acknowledging",
                context: { ...context, accepted: true },
              }
            const cause = event.output.cause
            const reason =
              cause.reasons.length === 1 ? cause.reasons[0] : undefined
            const error = reason?._tag === "Fail" ? reason.error : cause
            const message = Schema.decodeUnknownOption(
              Schema.Struct({ message: Schema.String })
            )(error)
            return {
              target: rejectedModelAttempt(error)
                ? "rejectingModel"
                : "answering",
              context: {
                ...context,
                failure: cause,
                error:
                  message._tag === "Some"
                    ? message.value.message
                    : "Could not send",
              },
            }
          },
        },
      },
      acknowledging: {
        invoke: {
          src: "acknowledge",
          input: ({ context }) => context.pending!,
          onDone: ({ context, event }) => ({
            target: "answering",
            context: {
              ...context,
              pending: null,
              failure: Exit.isFailure(event.output)
                ? event.output.cause
                : undefined,
            },
          }),
        },
      },
      rejectingModel: {
        invoke: {
          src: "rejectModel",
          input: ({ context }) => context.pending!,
          onDone: ({ context, event }) => ({
            target: "answering",
            context: {
              ...context,
              pending: null,
              failure: Exit.isFailure(event.output)
                ? Cause.combine(
                    context.failure as Cause.Cause<unknown>,
                    event.output.cause
                  )
                : context.failure,
            },
          }),
        },
      },
      answering: {
        invoke: {
          src: "answer",
          input: ({ context }) => ({
            reply: context.reply!,
            accepted: context.accepted,
          }),
          onDone: ({ context }) => ({
            target: "ready",
            context: { ...context, reply: null },
          }),
        },
      },
    },
  })
}
