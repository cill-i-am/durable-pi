import { Context, Schema, type Effect } from "effect"

export class BackupFailure extends Schema.TaggedError<BackupFailure>()(
  "BackupFailure",
  {
    reason: Schema.Literals([
      "transport",
      "conflict",
      "invalid",
      "missing",
      "ahead",
    ]),
    message: Schema.String,
  }
) {}

/** Object storage semantics, independent of R2 and its SDK body handles. */
export class BackupStore extends Context.Service<
  BackupStore,
  {
    get: (
      key: string
    ) => Effect.Effect<{ etag: string; text: string } | null, BackupFailure>
    put: (
      key: string,
      data: string,
      condition?: { etag: string } | { absent: true }
    ) => Effect.Effect<void, BackupFailure>
  }
>()("durable-pi/memory/BackupStore") {}
