import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import {
  describeExecutableEffect,
  initialTransition,
  transition,
  type EventFromLogic,
  type ExecutableEffect,
} from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import {
  runtimeLibraryVersion,
  nativePiVersion,
  StoredLibraryVersion,
  StoredPiVersion,
} from "../../src/shared/runtime-versions"

const counter = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
)
const identity = {
  operationId: Schema.String.check(Schema.isMinLength(1)),
  content: Schema.String,
  generation: counter,
  attempt: counter,
}
const fence = {
  revision: counter,
  generation: counter,
  attempt: counter,
}
const Context = Schema.Struct({
  ...identity,
  revision: counter,
  deadline: counter,
})
export const SubmitCommand = Schema.Struct({
  type: Schema.Literal("pi.submit"),
  ...identity,
})

/** Only this machine decides application progression. Pi owns execution. */
export const submissionMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: Context,
    context: Context,
    events: {
      SUBMIT: Schema.Struct(fence),
      COMPLETED: Schema.Struct(fence),
      UNCONFIRMED: Schema.Struct(fence),
      TIMEOUT: Schema.Struct({ ...fence, now: counter }),
    },
    emitted: { "pi.submit": Schema.Struct(identity) },
  },
}).createMachine({
  id: "submission-reference",
  version: "1",
  context: ({ input }) => input,
  initial: "ready",
  states: {
    ready: {
      on: {
        SUBMIT: ({ context, event }, enq) => {
          if (!owns(context, event)) return
          const { revision, deadline: _, ...command } = context
          enq.emit({ type: "pi.submit", ...command })
          return {
            target: "pending",
            context: { ...context, revision: revision + 1 },
          }
        },
      },
    },
    pending: {
      on: {
        COMPLETED: ({ context, event }) => {
          if (!owns(context, event)) return
          return {
            target: "complete",
            context: { ...context, revision: context.revision + 1 },
          }
        },
        UNCONFIRMED: ({ context, event }) => {
          if (!owns(context, event)) return
          return {
            target: "unconfirmed",
            context: { ...context, revision: context.revision + 1 },
          }
        },
        TIMEOUT: ({ context, event }) => {
          if (!owns(context, event) || event.now < context.deadline) return
          return {
            target: "unconfirmed",
            context: { ...context, revision: context.revision + 1 },
          }
        },
      },
    },
    complete: { type: "final" },
    unconfirmed: { type: "final" },
  },
})

function owns(
  context: typeof Context.Type,
  event: {
    revision: number
    generation: number
    attempt: number
  }
) {
  return (
    context.revision === event.revision &&
    context.generation === event.generation &&
    context.attempt === event.attempt
  )
}

// Domain data is authoritative; no second independently writable library snapshot.
// Changing any version requires an explicit compatibility test or migration.
export const SubmissionState = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  libraryVersion: StoredLibraryVersion,
  piVersion: StoredPiVersion,
  value: Schema.Literals(["ready", "pending", "complete", "unconfirmed"]),
  context: Context,
}).check(
  Schema.makeFilter(
    (state) =>
      state.context.revision ===
      { ready: 0, pending: 1, complete: 2, unconfirmed: 2 }[state.value]
  )
)
export type SubmissionState = typeof SubmissionState.Type

export function newSubmission(
  operationId: string,
  content: string,
  deadline = Number.MAX_SAFE_INTEGER
): SubmissionState {
  const [snapshot, effects] = initialTransition(submissionMachine, {
    operationId,
    content,
    generation: 1,
    attempt: 1,
    revision: 0,
    deadline,
  })
  commandsFrom(effects)
  return {
    schemaVersion: 1,
    workflowVersion: 1,
    libraryVersion: runtimeLibraryVersion,
    piVersion: nativePiVersion,
    value: "ready",
    context: snapshot.context,
  }
}

/** The deliberately small durable mapping rejects every unimplemented descriptor. */
export function commandsFrom(effects: readonly ExecutableEffect[]) {
  return effects.flatMap((effect) => {
    const descriptor = describeExecutableEffect(effect)
    if (descriptor.kind === "emit")
      return [Schema.decodeUnknownSync(SubmitCommand)(descriptor.event)]
    if (effect.type === "@xstate.terminate") return []
    throw new Error(`Unsupported durable machine effect: ${effect.type}`)
  })
}

export function decideSubmission(
  saved: unknown,
  event: EventFromLogic<typeof submissionMachine>
) {
  const state = Schema.decodeUnknownSync(SubmissionState)(saved)
  const snapshot = submissionMachine.resolveState({
    value: state.value,
    context: state.context,
  })
  const [next, effects] = transition(submissionMachine, snapshot, event)
  const commands = commandsFrom(effects)
  const updated = Schema.decodeUnknownSync(SubmissionState)({
    ...state,
    value: next.value,
    context: next.context,
  })
  return { state: updated, commands }
}
