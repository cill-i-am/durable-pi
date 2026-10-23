import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import type { BackupFailure } from "./backup-store"
import type { MemoryError } from "./domain"
import { advance, ArchiveRecord, PartSchema, WatermarkSchema } from "./records"

export const BackupManifest = Schema.Struct({
  version: Schema.Literal(1),
  head: Schema.NullOr(Schema.String),
  until: WatermarkSchema,
  parts: Schema.Array(PartSchema),
  date: Schema.String,
})
export type BackupManifest = typeof BackupManifest.Type
export const BackupObservation = Schema.Struct({
  prior: Schema.NullOr(BackupManifest),
  checkpointEtag: Schema.NullOr(Schema.String),
  latest: Schema.NullOr(BackupManifest),
  latestEtag: Schema.NullOr(Schema.String),
  until: WatermarkSchema,
  parts: Schema.Array(PartSchema),
})
export type BackupObservation = typeof BackupObservation.Type
export const BackupCursor = Schema.Struct({
  head: Schema.NullOr(Schema.String),
  after: WatermarkSchema,
  pages: Schema.Int,
})
export type BackupCursor = typeof BackupCursor.Type
export type BackupResult = { pending: boolean; date: string }
export type BackupError = BackupFailure | MemoryError
export const sameBackupWatermark = (
  a: typeof WatermarkSchema.Type,
  b: typeof WatermarkSchema.Type
) => a.messages === b.messages && a.nodes === b.nodes && a.notes === b.notes
const complete = (context: Context) =>
  sameBackupWatermark(context.cursor.after, context.observation!.until)
const outcome = Schema.declare(
  (value): value is Exit.Exit<BackupResult, BackupError> => Exit.isExit(value)
)
const Context = Schema.Struct({
  observation: Schema.NullOr(BackupObservation),
  cursor: BackupCursor,
  records: Schema.Array(ArchiveRecord),
  manifest: Schema.NullOr(BackupManifest),
  outcome,
})
type Context = typeof Context.Type
export interface BackupPublicationWork {
  load: Effect.Effect<BackupObservation, BackupError>
  page: (
    observation: BackupObservation,
    cursor: BackupCursor
  ) => Effect.Effect<readonly ArchiveRecord[], BackupError>
  batch: (
    cursor: BackupCursor,
    records: readonly ArchiveRecord[]
  ) => Effect.Effect<string, BackupError>
  manifest: (
    observation: BackupObservation,
    cursor: BackupCursor,
    complete: boolean
  ) => Effect.Effect<BackupManifest, BackupError>
  checkpoint: (
    observation: BackupObservation,
    manifest: BackupManifest,
    complete: boolean
  ) => Effect.Effect<void, BackupError>
  publish: (
    observation: BackupObservation,
    manifest: BackupManifest
  ) => Effect.Effect<void, BackupError>
}
const failed = (context: Context, cause: Cause.Cause<BackupError>) => ({
  target: "settled",
  context: { ...context, outcome: Exit.failCause(cause) },
})

/** Existing manifests reconstruct remote progress. This scoped machine owns
 * page/upload/checkpoint/publication order; no machine snapshot is persisted. */
export function backupPublicationMachine(work: BackupPublicationWork) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: { context: Context, output: outcome },
    actors: {
      load: createEffectLogic(Effect.exit(work.load)),
      page: createEffectLogic(({ input }: { input: Context }) =>
        Effect.exit(work.page(input.observation!, input.cursor))
      ),
      batch: createEffectLogic(({ input }: { input: Context }) =>
        Effect.exit(work.batch(input.cursor, input.records))
      ),
      manifest: createEffectLogic(({ input }: { input: Context }) =>
        Effect.exit(
          work.manifest(input.observation!, input.cursor, complete(input))
        )
      ),
      checkpoint: createEffectLogic(({ input }: { input: Context }) =>
        Effect.exit(
          work.checkpoint(input.observation!, input.manifest!, complete(input))
        )
      ),
      publish: createEffectLogic(({ input }: { input: Context }) =>
        Effect.exit(work.publish(input.observation!, input.manifest!))
      ),
    },
  }).createMachine({
    id: "memory-backup-publication",
    version: "1",
    initial: "loading",
    context: {
      observation: null,
      cursor: {
        head: null,
        after: { messages: 0, nodes: 0, notes: 0 },
        pages: 0,
      },
      records: [],
      manifest: null,
      outcome: Exit.succeed({ pending: true, date: "" }),
    },
    output: ({ context }) => context.outcome,
    states: {
      loading: {
        invoke: {
          src: "load",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output.cause)
              : {
                  target: "paging",
                  context: {
                    ...context,
                    observation: event.output.value,
                    cursor: {
                      ...context.cursor,
                      head: event.output.value.prior?.head ?? null,
                      after:
                        event.output.value.prior?.until ?? context.cursor.after,
                    },
                  },
                },
        },
      },
      paging: {
        invoke: {
          src: "page",
          input: ({ context }) => context,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output.cause)
              : event.output.value.length
                ? {
                    target: "uploading",
                    context: { ...context, records: event.output.value },
                  }
                : { target: "manifest" },
        },
      },
      uploading: {
        invoke: {
          src: "batch",
          input: ({ context }) => context,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output.cause)
              : {
                  target: context.cursor.pages + 1 >= 8 ? "manifest" : "paging",
                  context: {
                    ...context,
                    cursor: {
                      head: event.output.value,
                      after: advance(context.cursor.after, context.records),
                      pages: context.cursor.pages + 1,
                    },
                    records: [],
                  },
                },
        },
      },
      manifest: {
        invoke: {
          src: "manifest",
          input: ({ context }) => context,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output.cause)
              : {
                  target: "checkpointing",
                  context: { ...context, manifest: event.output.value },
                },
        },
      },
      checkpointing: {
        invoke: {
          src: "checkpoint",
          input: ({ context }) => context,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output.cause)
              : complete(context)
                ? { target: "publishing" }
                : {
                    target: "settled",
                    context: {
                      ...context,
                      outcome: Exit.succeed({
                        pending: true,
                        date: context.manifest!.date,
                      }),
                    },
                  },
        },
      },
      publishing: {
        invoke: {
          src: "publish",
          input: ({ context }) => context,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output.cause)
              : {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.succeed({
                      pending: false,
                      date: context.manifest!.date,
                    }),
                  },
                },
        },
      },
      settled: { type: "final" },
    },
  })
}
