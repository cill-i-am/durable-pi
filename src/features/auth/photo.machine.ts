import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { authMessage } from "./auth-contracts"

// Native File/Blob identity stays at the capability boundary; machines retain
// the opaque value only while its preparation/upload is owned.
const FileValue = Schema.declare(
  (value): value is File =>
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "arrayBuffer" in value
)
const Photo = Schema.declare(
  (value): value is Blob =>
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "arrayBuffer" in value
)
export type PhotoWork = {
  prepare: (file: File) => Effect.Effect<Blob, unknown, Scope.Scope>
  save: (photo: Blob | null) => Effect.Effect<void, unknown, Scope.Scope>
  refresh: () => Effect.Effect<void, unknown, Scope.Scope>
}
export function photoMachine(work: PhotoWork) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        file: Schema.NullOr(FileValue),
        photo: Schema.NullOr(Photo),
        removing: Schema.Boolean,
        error: Schema.String,
        notice: Schema.String,
        failure: Schema.UndefinedOr(Schema.Unknown),
      }),
      events: { SAVE: Schema.Struct({ file: Schema.NullOr(FileValue) }) },
    },
    actors: {
      prepare: createEffectLogic(({ input }: { input: File }) =>
        Effect.exit(work.prepare(input))
      ),
      save: createEffectLogic(({ input }: { input: Blob | null }) =>
        Effect.exit(work.save(input))
      ),
      refresh: createEffectLogic(() => Effect.exit(work.refresh())),
    },
  }).createMachine({
    id: "profile-photo",
    initial: "ready",
    context: {
      file: null,
      photo: null,
      removing: false,
      error: "",
      notice: "",
      failure: undefined,
    },
    states: {
      ready: {
        on: {
          SAVE: ({ context, event }) => ({
            target: event.file ? "preparing" : "saving",
            context: {
              ...context,
              file: event.file,
              photo: null,
              removing: !event.file,
              error: "",
              notice: "",
              failure: undefined,
            },
          }),
        },
      },
      preparing: {
        invoke: {
          src: "prepare",
          input: ({ context }) => context.file!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "ready",
                  context: {
                    ...context,
                    file: null,
                    error: authMessage(
                      event.output.cause,
                      "Could not prepare that photo. Try another image."
                    ).message,
                    failure: event.output.cause,
                  },
                }
              : {
                  target: "saving",
                  context: {
                    ...context,
                    file: null,
                    photo: event.output.value,
                  },
                },
        },
      },
      saving: {
        invoke: {
          src: "save",
          input: ({ context }) => context.photo,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "ready",
                  context: {
                    ...context,
                    photo: null,
                    error: authMessage(
                      event.output.cause,
                      "Could not confirm the photo update. Reload and try again."
                    ).message,
                    failure: event.output.cause,
                  },
                }
              : { target: "refreshing", context: { ...context, photo: null } },
        },
      },
      refreshing: {
        invoke: {
          src: "refresh",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "ready",
                  context: {
                    ...context,
                    error:
                      "Your photo was saved. Reload to see the updated profile.",
                    failure: event.output.cause,
                  },
                }
              : {
                  target: "ready",
                  context: {
                    ...context,
                    notice: context.removing
                      ? "Profile photo removed."
                      : "Profile photo updated.",
                  },
                },
        },
      },
    },
  })
}
