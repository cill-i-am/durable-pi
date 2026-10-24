import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

export interface MemoryImportFile {
  readonly name: string
  readonly size: number
  text(): Promise<string>
}
const file = Schema.declare(
  (value): value is MemoryImportFile =>
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "size" in value &&
    typeof value.size === "number" &&
    "text" in value &&
    typeof value.text === "function"
)
export const MemoryImportResult = Schema.Struct({
  added: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
const outcome = Schema.declare(
  (value): value is Exit.Exit<typeof MemoryImportResult.Type, unknown> =>
    Exit.isExit(value)
)
export type MemoryImportWork = {
  read: (file: MemoryImportFile) => Effect.Effect<string, unknown, Scope.Scope>
  submit: (
    jsonl: string
  ) => Effect.Effect<typeof MemoryImportResult.Type, unknown, Scope.Scope>
}
/** One captured file/body per attempt; server content identity owns deduplication. */
export function memoryImportMachine(work: MemoryImportWork) {
  const select = ({
    event,
  }: {
    event: { file: MemoryImportFile | null; id: string }
  }) => ({
    target: "ready",
    context: {
      file: event.file,
      id: event.id,
      jsonl: null,
      outcome: undefined,
    },
  })
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        file: Schema.NullOr(file),
        id: Schema.NullOr(Schema.String),
        jsonl: Schema.NullOr(Schema.String),
        outcome: Schema.UndefinedOr(outcome),
      }),
      events: {
        SELECT: Schema.Struct({ file: Schema.NullOr(file), id: Schema.String }),
        SUBMIT: Schema.Struct({}),
        RETRY: Schema.Struct({}),
      },
    },
    actors: {
      read: createEffectLogic({
        schemas: { input: file },
        effect: ({ input }) => Effect.exit(work.read(input)),
      }),
      submit: createEffectLogic({
        schemas: { input: Schema.String },
        effect: ({ input }) => Effect.exit(work.submit(input)),
      }),
    },
  }).createMachine({
    id: "memory-history-import",
    initial: "ready",
    context: () => ({ file: null, id: null, jsonl: null, outcome: undefined }),
    states: {
      ready: {
        on: {
          SELECT: select,
          SUBMIT: ({ context }) =>
            context.file ? { target: "reading" } : undefined,
        },
      },
      reading: {
        invoke: {
          src: "read",
          input: ({ context }) => context.file!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "unconfirmed",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : {
                  target: "submitting",
                  context: { ...context, jsonl: event.output.value },
                },
        },
      },
      submitting: {
        invoke: {
          src: "submit",
          input: ({ context }) => context.jsonl!,
          onDone: ({ context, event }) => ({
            target: Exit.isSuccess(event.output) ? "done" : "unconfirmed",
            context: { ...context, outcome: event.output },
          }),
        },
      },
      unconfirmed: {
        on: {
          SELECT: select,
          RETRY: ({ context }) => ({
            target: context.jsonl === null ? "reading" : "submitting",
            context: { ...context, outcome: undefined },
          }),
        },
      },
      done: { on: { SELECT: select } },
    },
  })
}
