import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { FileInfo, MAX_FILE_BYTES } from "@/workspace/files"

import { UploadRequest } from "./file-types"

/** One reservation identity per browser upload, including explicit retries. */
export function uploadMachine(
  upload: (attempt: UploadRequest) => Effect.Effect<FileInfo, unknown>,
  publish: (attempt: UploadRequest, file: FileInfo) => Effect.Effect<void>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: UploadRequest,
      context: Schema.Struct({
        request: UploadRequest,
        file: Schema.NullOr(FileInfo),
        failure: Schema.UndefinedOr(Schema.Unknown),
      }),
      events: {},
    },
    actors: {
      upload: createEffectLogic(({ input }: { input: UploadRequest }) =>
        upload(input)
      ),
      publish: createEffectLogic(
        ({ input }: { input: { request: UploadRequest; file: FileInfo } }) =>
          publish(input.request, input.file)
      ),
    },
  }).createMachine({
    id: "file-upload",
    initial: "checking",
    context: ({ input }) => ({
      request: input,
      file: null,
      failure: undefined,
    }),
    states: {
      checking: {
        always: ({ context }) =>
          !context.request.file.size ||
          context.request.file.size > MAX_FILE_BYTES
            ? {
                target: "failed",
                context: {
                  ...context,
                  failure: new Error("Choose a non-empty file up to 8 MB."),
                },
              }
            : { target: "uploading" },
      },
      uploading: {
        invoke: {
          src: "upload",
          input: ({ context }) => context.request,
          onDone: ({ context, event }) => ({
            target: "publishing",
            context: { ...context, file: event.output },
          }),
          onError: ({ context, event }) => ({
            target: "failed",
            context: { ...context, failure: event.error },
          }),
        },
      },
      publishing: {
        invoke: {
          src: "publish",
          input: ({ context }) => ({
            request: context.request,
            file: context.file!,
          }),
          onDone: { target: "done" },
        },
      },
      done: { type: "final" },
      failed: { type: "final" },
    },
  })
}
