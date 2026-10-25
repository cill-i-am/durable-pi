import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

const FileValue = Schema.File
export function exportSaveMachine(work: {
  download: Effect.Effect<File, unknown>
  upload: (file: File) => Effect.Effect<unknown, unknown>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        file: Schema.NullOr(FileValue),
        message: Schema.String,
        failure: Schema.Unknown,
      }),
      events: { SAVE: Schema.Struct({}) },
    },
    actors: {
      download: createEffectLogic(Effect.exit(work.download)),
      upload: createEffectLogic(({ input }: { input: File }) =>
        Effect.exit(work.upload(input))
      ),
    },
  }).createMachine({
    id: "terminal-export-save",
    initial: "idle",
    context: () => ({ file: null, message: "", failure: undefined }),
    states: {
      idle: { on: { SAVE: { target: "downloading" } } },
      downloading: {
        invoke: {
          src: "download",
          onDone: ({ event }) =>
            Exit.isSuccess(event.output)
              ? {
                  target: "uploading",
                  context: {
                    file: event.output.value,
                    message: "",
                    failure: undefined,
                  },
                }
              : {
                  target: "failed",
                  context: {
                    file: null,
                    message:
                      "Could not prepare the export. Retry the same export.",
                    failure: event.output.cause,
                  },
                },
        },
      },
      uploading: {
        invoke: {
          src: "upload",
          input: ({ context }) => context.file!,
          onDone: ({ event, context }) =>
            Exit.isSuccess(event.output)
              ? {
                  target: "saved",
                  context: {
                    file: null,
                    failure: undefined,
                    message:
                      "Saved to this bot’s Files. You can preview, download or attach it there.",
                  },
                }
              : {
                  target: "failed",
                  context: {
                    ...context,
                    failure: event.output.cause,
                    message:
                      "Could not confirm saving to Files. Retry keeps the same export ID.",
                  },
                },
        },
      },
      saved: {},
      failed: {
        on: {
          SAVE: ({ context }) => ({
            target: context.file ? "uploading" : "downloading",
            context: { ...context, message: "" },
          }),
        },
      },
    },
  })
}
