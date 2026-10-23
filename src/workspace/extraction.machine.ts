import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import type { ExtractedDocument, DocumentUnreadable } from "./documents"
import type { FileError } from "./files"
import type { VideoResult, VideoUnreadable } from "./video"

export type PreparationFailure =
  | FileError
  | DocumentUnreadable
  | VideoUnreadable
export type PreparedArtifact = {
  bytes: Uint8Array | null
  document: ExtractedDocument | null
  video: VideoResult | null
}
export interface ExtractionWork {
  read: Effect.Effect<Uint8Array, PreparationFailure>
  decode: (
    bytes: Uint8Array
  ) => Effect.Effect<PreparedArtifact, PreparationFailure>
  publish: (
    result: PreparedArtifact
  ) => Effect.Effect<string | null, PreparationFailure>
  commit: (
    result: PreparedArtifact,
    hash: string | null
  ) => Effect.Effect<void, PreparationFailure>
  recover: (
    cause: Cause.Cause<PreparationFailure>
  ) => Effect.Effect<void, FileError>
}
export function extractionMachine(work: ExtractionWork) {
  const outcome = Schema.declare((value): value is Exit.Exit<void, FileError> =>
    Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        original: Schema.NullOr(Schema.Uint8Array),
        result: Schema.NullOr(
          Schema.declare(
            (value): value is PreparedArtifact =>
              typeof value === "object" && value !== null
          )
        ),
        hash: Schema.NullOr(Schema.String),
        outcome,
        failure: Schema.NullOr(
          Schema.declare((value): value is Cause.Cause<PreparationFailure> =>
            Cause.isCause(value)
          )
        ),
      }),
      output: Schema.declare((value): value is Exit.Exit<void, FileError> =>
        Exit.isExit(value)
      ),
    },
    actors: {
      read: createEffectLogic(Effect.exit(work.read)),
      decode: createEffectLogic(({ input }: { input: Uint8Array }) =>
        Effect.exit(work.decode(input))
      ),
      publish: createEffectLogic(({ input }: { input: PreparedArtifact }) =>
        Effect.exit(work.publish(input))
      ),
      commit: createEffectLogic(
        ({
          input,
        }: {
          input: { result: PreparedArtifact; hash: string | null }
        }) => Effect.exit(work.commit(input.result, input.hash))
      ),
      recover: createEffectLogic(
        ({ input }: { input: Cause.Cause<PreparationFailure> }) =>
          Effect.exit(work.recover(input))
      ),
    },
  }).createMachine({
    id: "workspace-extraction",
    initial: "reading",
    context: {
      original: null,
      result: null,
      hash: null,
      outcome: Exit.void as Exit.Exit<void, FileError>,
      failure: null,
    },
    output: ({ context }) => context.outcome,
    states: {
      reading: {
        invoke: {
          src: "read",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "recovering",
                  context: { ...context, failure: event.output.cause },
                }
              : {
                  target: "decoding",
                  context: { ...context, original: event.output.value },
                },
        },
      },
      decoding: {
        invoke: {
          src: "decode",
          input: ({ context }) => context.original!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "recovering",
                  context: { ...context, failure: event.output.cause },
                }
              : {
                  target: "publishing",
                  context: {
                    ...context,
                    original: null,
                    result: event.output.value,
                  },
                },
        },
      },
      publishing: {
        invoke: {
          src: "publish",
          input: ({ context }) => context.result!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "recovering",
                  context: { ...context, failure: event.output.cause },
                }
              : {
                  target: "committing",
                  context: { ...context, hash: event.output.value },
                },
        },
      },
      committing: {
        invoke: {
          src: "commit",
          input: ({ context }) => ({
            result: context.result!,
            hash: context.hash,
          }),
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "recovering",
                  context: { ...context, failure: event.output.cause },
                }
              : {
                  target: "settled",
                  context: { ...context, outcome: Exit.void },
                },
        },
      },
      recovering: {
        invoke: {
          src: "recover",
          input: ({ context }) => context.failure!,
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
