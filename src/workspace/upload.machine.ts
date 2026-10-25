import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { StoredAudio } from "./audio"
import { FileInfo, type FileError } from "./files"
import type { WorkspaceFile } from "./ledger"

export interface UploadWork {
  reserve: Effect.Effect<WorkspaceFile, FileError>
  original: (file: WorkspaceFile) => Effect.Effect<void, FileError>
  image: Effect.Effect<string, FileError>
  audio: Effect.Effect<StoredAudio, FileError>
  arm: Effect.Effect<number, FileError>
  publish: (
    file: WorkspaceFile,
    visionHash: string | null,
    audio: StoredAudio | null,
    deadline: number
  ) => Effect.Effect<FileInfo, FileError>
  info: (file: WorkspaceFile) => Effect.Effect<FileInfo, FileError>
}
export function uploadMachine(work: UploadWork) {
  const outcome = Schema.declare(
    (value): value is Exit.Exit<FileInfo, FileError> => Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        file: Schema.NullOr(
          Schema.declare(
            (value): value is WorkspaceFile =>
              typeof value === "object" && value !== null
          )
        ),
        visionHash: Schema.NullOr(Schema.String),
        audio: Schema.NullOr(StoredAudio),
        deadline: Schema.Number,
        outcome: Schema.NullOr(outcome),
      }),
      output: outcome,
    },
    actors: {
      reserve: createEffectLogic(Effect.exit(work.reserve)),
      original: createEffectLogic(({ input }: { input: WorkspaceFile }) =>
        Effect.exit(work.original(input))
      ),
      image: createEffectLogic(Effect.exit(work.image)),
      audio: createEffectLogic(Effect.exit(work.audio)),
      arm: createEffectLogic(Effect.exit(work.arm)),
      publish: createEffectLogic(
        ({
          input,
        }: {
          input: {
            file: WorkspaceFile
            visionHash: string | null
            audio: StoredAudio | null
            deadline: number
          }
        }) =>
          Effect.exit(
            work.publish(
              input.file,
              input.visionHash,
              input.audio,
              input.deadline
            )
          )
      ),
      info: createEffectLogic(({ input }: { input: WorkspaceFile }) =>
        Effect.exit(work.info(input))
      ),
    },
  }).createMachine({
    id: "workspace-upload",
    context: {
      file: null,
      visionHash: null,
      audio: null,
      deadline: 0,
      outcome: null,
    },
    output: ({ context }) => context.outcome!,
    initial: "reserving",
    states: {
      reserving: {
        invoke: {
          src: "reserve",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : {
                  target:
                    event.output.value.status === "ready"
                      ? "replaying"
                      : "writing",
                  context: { ...context, file: event.output.value },
                },
        },
      },
      replaying: {
        invoke: {
          src: "info",
          input: ({ context }) => context.file!,
          onDone: ({ context, event }) => ({
            target: "settled",
            context: { ...context, outcome: event.output },
          }),
        },
      },
      writing: {
        invoke: {
          src: "original",
          input: ({ context }) => context.file!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : {
                  target:
                    context.file!.kind === "image"
                      ? "preparingImage"
                      : context.file!.kind === "audio"
                        ? "transcribing"
                        : "arming",
                },
        },
      },
      preparingImage: {
        invoke: {
          src: "image",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : {
                  target: "arming",
                  context: { ...context, visionHash: event.output.value },
                },
        },
      },
      transcribing: {
        invoke: {
          src: "audio",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : {
                  target: "arming",
                  context: { ...context, audio: event.output.value },
                },
        },
      },
      arming: {
        invoke: {
          src: "arm",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : {
                  target: "publishing",
                  context: { ...context, deadline: event.output.value },
                },
        },
      },
      publishing: {
        invoke: {
          src: "publish",
          input: ({ context }) => ({ ...context, file: context.file! }),
          onDone: ({ context, event }) => ({
            target: "settled",
            context: { ...context, outcome: event.output },
          }),
        },
      },
      settled: { type: "final" },
    },
  })
}
