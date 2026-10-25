import { createEffectLogic, setupEffect, withActorScope } from "@xstate/effect"
import { Cause, Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

export interface VoiceCapture {
  readonly ready: Effect.Effect<void, unknown>
  readonly record: Effect.Effect<File | null, unknown>
  readonly finish: Effect.Effect<File | null, unknown>
  readonly close: Effect.Effect<void>
}
const capture = Schema.declare(
  (value): value is VoiceCapture =>
    typeof value === "object" &&
    value !== null &&
    "ready" in value &&
    Effect.isEffect(value.ready) &&
    "close" in value &&
    Effect.isEffect(value.close)
)
const file = Schema.declare(
  (value): value is File =>
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "arrayBuffer" in value &&
    typeof value.arrayBuffer === "function"
)
const failure = (cause: Cause.Cause<unknown>) => {
  const reason = cause.reasons.find((reason) => reason._tag === "Fail")
  return typeof reason?.error === "object" &&
    reason.error !== null &&
    "message" in reason.error &&
    typeof reason.error.message === "string"
    ? reason.error.message
    : "Recording failed. Try again or upload an audio file."
}

/** A cancelled acquisition keeps its microphone lease until joined release. */
export function voiceRecorderMachine(work: {
  open: () => Effect.Effect<VoiceCapture, never, Scope.Scope>
  upload: (file: File) => Effect.Effect<void, unknown>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        capture: Schema.NullOr(capture),
        file: Schema.NullOr(file),
        error: Schema.String,
        cancelled: Schema.Boolean,
      }),
      events: {
        START: Schema.Struct({}),
        FINISH: Schema.Struct({}),
        CANCEL: Schema.Struct({}),
      },
    },
    actors: {
      open: createEffectLogic(() => withActorScope(work.open())),
      ready: createEffectLogic(({ input }: { input: VoiceCapture }) =>
        Effect.exit(input.ready)
      ),
      record: createEffectLogic(({ input }: { input: VoiceCapture }) =>
        Effect.exit(input.record)
      ),
      finish: createEffectLogic(({ input }: { input: VoiceCapture }) =>
        Effect.exit(input.finish)
      ),
      release: createEffectLogic(({ input }: { input: VoiceCapture }) =>
        Effect.exit(input.close)
      ),
      upload: createEffectLogic(({ input }: { input: File }) =>
        Effect.exit(work.upload(input))
      ),
    },
  }).createMachine({
    id: "voice-recorder",
    initial: "idle",
    context: {
      capture: null as VoiceCapture | null,
      file: null as File | null,
      error: "",
      cancelled: false,
    },
    states: {
      idle: {
        on: {
          START: {
            target: "opening",
            context: () => ({
              capture: null,
              file: null,
              error: "",
              cancelled: false,
            }),
          },
        },
      },
      opening: {
        on: {
          CANCEL: {
            context: ({ context }) => ({ ...context, cancelled: true }),
          },
        },
        invoke: {
          src: "open",
          onDone: ({ context, event }) => ({
            target: context.cancelled ? "releasing" : "acquiring",
            context: { ...context, capture: event.output },
          }),
        },
      },
      acquiring: {
        invoke: {
          src: "ready",
          input: ({ context }) => context.capture!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "releasing",
                  context: { ...context, error: failure(event.output.cause) },
                }
              : { target: "recording" },
        },
        on: { CANCEL: { target: "releasing" } },
      },
      recording: {
        invoke: {
          src: "record",
          input: ({ context }) => context.capture!,
          onDone: ({ context, event }) => ({
            target: "releasing",
            context: {
              ...context,
              file: Exit.isSuccess(event.output) ? event.output.value : null,
              error: Exit.isFailure(event.output)
                ? failure(event.output.cause)
                : "",
            },
          }),
        },
        after: { 600000: { target: "finishing" } },
        on: {
          FINISH: { target: "finishing" },
          CANCEL: { target: "releasing" },
        },
      },
      finishing: {
        invoke: {
          src: "finish",
          input: ({ context }) => context.capture!,
          onDone: ({ context, event }) => ({
            target: "releasing",
            context: {
              ...context,
              file: Exit.isSuccess(event.output) ? event.output.value : null,
              error: Exit.isFailure(event.output)
                ? failure(event.output.cause)
                : "",
            },
          }),
        },
        on: { CANCEL: { target: "releasing" } },
      },
      releasing: {
        invoke: {
          src: "release",
          input: ({ context }) => context.capture!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "blocked",
                  context: {
                    ...context,
                    error:
                      "Could not finish releasing the microphone. Reload before recording again.",
                  },
                }
              : {
                  target: context.file ? "uploading" : "idle",
                  context: { ...context, capture: null },
                },
        },
      },
      uploading: {
        invoke: {
          src: "upload",
          input: ({ context }) => context.file!,
          onDone: ({ context, event }) => ({
            target: "idle",
            context: {
              ...context,
              file: null,
              error: Exit.isFailure(event.output)
                ? "Could not upload this recording. Try again."
                : "",
            },
          }),
        },
      },
      blocked: {},
    },
  })
}
