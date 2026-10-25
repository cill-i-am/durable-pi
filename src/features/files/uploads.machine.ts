import {
  createEffectActor,
  createEffectLogic,
  setupEffect,
  waitFor,
} from "@xstate/effect"
import { Deferred, Effect, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import type { FileInfo } from "@/workspace/files"

import { UploadAttempt, UploadRequest, fileFailure } from "./file-types"
import { uploadMachine } from "./upload.machine"

const reply = Schema.declare((value): value is Deferred.Deferred<void> =>
  Deferred.isDeferred(value)
)
const start = Schema.Struct({
  requests: Schema.Array(UploadRequest),
  capacity: Schema.Int,
  retry: Schema.Boolean,
  reply,
})
const context = Schema.Struct({
  attempts: Schema.Array(UploadAttempt),
  queue: Schema.Array(UploadRequest),
  reply: Schema.NullOr(reply),
  error: Schema.String,
})
export function uploadsMachine(
  upload: (attempt: UploadRequest) => Effect.Effect<FileInfo, unknown>,
  publish: (attempt: UploadRequest, file: FileInfo) => Effect.Effect<void>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context,
      events: {
        START: start,
        DISMISS: Schema.Struct({ id: Schema.String }),
        CLEAR_ERROR: Schema.Struct({}),
      },
    },
    actors: {
      one: createEffectLogic(({ input }: { input: UploadRequest }) =>
        Effect.gen(function* () {
          const actor = yield* createEffectActor(
            uploadMachine(upload, publish),
            { input }
          )
          return yield* waitFor(actor, (snapshot) => snapshot.status === "done")
        }).pipe(Effect.scoped)
      ),
    },
    actions: {
      answer: ({ params }: { params?: unknown }) =>
        Deferred.succeed(Schema.decodeUnknownSync(reply)(params), undefined),
    },
  }).createMachine({
    id: "file-upload-batch",
    initial: "idle",
    context: { attempts: [], queue: [], reply: null, error: "" },
    on: {
      CLEAR_ERROR: ({ context }) => ({ context: { ...context, error: "" } }),
      START: (args, enq) => {
        enq(args.actions.answer, { ...args, params: args.event.reply })
      },
      DISMISS: ({ context, event }) => ({
        context: {
          ...context,
          attempts: context.attempts.filter(
            (attempt) => attempt.id !== event.id || attempt.status !== "failed"
          ),
        },
      }),
    },
    states: {
      idle: {
        on: {
          START: (args, enq) => {
            const { context, event } = args
            const old =
              event.requests.length === 1
                ? context.attempts.find(
                    (attempt) => attempt.id === event.requests[0]!.id
                  )
                : undefined
            const validRetry =
              !event.retry ||
              (old?.status === "failed" &&
                old.file === event.requests[0]!.file &&
                old.attach === event.requests[0]!.attach)
            const unique =
              new Set(event.requests.map((item) => item.id)).size ===
              event.requests.length
            if (
              !validRetry ||
              !unique ||
              !event.requests.length ||
              event.requests.length > event.capacity
            ) {
              enq(args.actions.answer, { ...args, params: event.reply })
              return {
                context: {
                  ...context,
                  error:
                    event.requests.length > event.capacity
                      ? event.retry
                        ? "Remove a message attachment before retrying this upload."
                        : `Choose up to ${Math.max(0, event.capacity)} more files.`
                      : context.error,
                },
              }
            }
            return {
              target: "uploading",
              context: {
                attempts: [
                  ...context.attempts.filter(
                    (item) =>
                      !event.requests.some((request) => request.id === item.id)
                  ),
                  ...event.requests.map((request) => ({
                    ...request,
                    status: "uploading" as const,
                  })),
                ],
                queue: event.requests,
                reply: event.reply,
                error: "",
              },
            }
          },
        },
      },
      uploading: {
        invoke: {
          src: "one",
          input: ({ context }) => context.queue[0]!,
          onDone: (args, enq) => {
            const { context, event } = args,
              request = context.queue[0]!,
              remaining = context.queue.slice(1),
              result = event.output.context
            const attempts = result.file
              ? context.attempts.filter((item) => item.id !== request.id)
              : context.attempts.map((item) =>
                  item.id === request.id
                    ? {
                        ...item,
                        status: "failed" as const,
                        error: fileFailure(
                          result.failure,
                          "Upload interrupted. Retry."
                        ),
                      }
                    : item
                )
            if (!remaining.length)
              enq(args.actions.answer, { ...args, params: context.reply! })
            return {
              target: remaining.length ? "uploading" : "idle",
              reenter: true,
              context: {
                ...context,
                attempts,
                queue: remaining,
                reply: remaining.length ? context.reply : null,
              },
            }
          },
        },
      },
    },
  })
}
