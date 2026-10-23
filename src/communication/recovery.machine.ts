import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import {
  describeExecutableEffect,
  transition,
  type ExecutableEffect,
} from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { MailboxRecovery } from "./contracts"

const timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const CommunicationDiscovery = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  armedUntil: timestamp,
  token: Schema.String.check(Schema.isNonEmpty()),
  recoveryEpoch: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
const Observation = Schema.Struct({ now: timestamp, pending: Schema.Boolean })
const Command = Schema.Union([
  Schema.Struct({ type: Schema.Literal("wake") }),
  Schema.Struct({ type: Schema.Literal("reschedule"), at: timestamp }),
])

/** This lease covers admission discovery, not the duration of native Pi work.
 * Its sole persisted representation is the existing Lifecycle job payload. */
export const communicationDiscoveryMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: CommunicationDiscovery,
    context: CommunicationDiscovery,
    events: {
      ARM: Schema.Struct({
        deadline: timestamp,
        token: Schema.String,
        recoveryEpoch: Schema.NullOr(Schema.String),
      }),
      OBSERVED: Observation,
    },
    emitted: {
      wake: Schema.Struct({}),
      reschedule: Schema.Struct({ at: timestamp }),
    },
  },
}).createMachine({
  id: "communication-discovery",
  version: "1",
  initial: "armed",
  context: ({ input }) => input,
  states: {
    armed: {
      on: {
        ARM: ({ context, event }) => ({
          context: {
            schemaVersion: context.schemaVersion,
            workflowVersion: context.workflowVersion,
            recoveryEpoch: event.recoveryEpoch,
            armedUntil: Math.max(context.armedUntil, event.deadline),
            token: event.token,
          },
        }),
        OBSERVED: ({ context, event }, enq) => {
          if (event.pending) enq.emit({ type: "wake" })
          if (context.armedUntil > event.now) {
            enq.emit({ type: "reschedule", at: context.armedUntil })
            return
          }
          return { target: "settled" }
        },
      },
    },
    settled: { type: "final" },
  },
})

export function communicationDiscoveryCommands(
  effects: readonly ExecutableEffect[]
) {
  return effects.flatMap((effect) => {
    if (effect.type === "@xstate.terminate") return []
    const descriptor = describeExecutableEffect(effect)
    if (descriptor.kind === "emit")
      return [Schema.decodeUnknownSync(Command)(descriptor.event)]
    throw new Error(
      `Unsupported communication discovery effect: ${effect.type}`
    )
  })
}
export function readCommunicationDiscovery(payload: unknown) {
  return Schema.decodeUnknownSync(CommunicationDiscovery)(payload)
}
export function armCommunicationDiscovery(
  prior: unknown,
  deadline: number,
  token: string,
  recoveryEpoch?: string
) {
  const context = readCommunicationDiscovery(
    prior ?? {
      schemaVersion: 1,
      workflowVersion: 1,
      armedUntil: deadline,
      token,
    }
  )
  const [next, effects] = transition(
    communicationDiscoveryMachine,
    communicationDiscoveryMachine.resolveState({ value: "armed", context }),
    { type: "ARM", deadline, token, recoveryEpoch: recoveryEpoch ?? null }
  )
  communicationDiscoveryCommands(effects)
  return readCommunicationDiscovery(next.context)
}
export function observeCommunicationDiscovery(
  payload: unknown,
  observation: typeof Observation.Type
) {
  const [_, effects] = transition(
    communicationDiscoveryMachine,
    communicationDiscoveryMachine.resolveState({
      value: "armed",
      context: readCommunicationDiscovery(payload),
    }),
    { type: "OBSERVED", ...observation }
  )
  return communicationDiscoveryCommands(effects)
}

export const MailboxRecoveryState = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  recovery: Schema.NullOr(MailboxRecovery),
  retiredEpoch: Schema.NullOr(Schema.String),
})
const RecoveryContext = MailboxRecoveryState
/** One exhausted unowned pump epoch, retained without an active alarm. This is
 * a Lifecycle scheduling fact, never an invented terminal outcome for a task. */
export const communicationRecoveryMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: RecoveryContext,
    context: RecoveryContext,
    events: {
      EXHAUSTED: Schema.Struct({ recovery: MailboxRecovery }),
      RETRY: Schema.Struct({
        epoch: Schema.String,
        now: timestamp,
        deadline: timestamp,
        pumpEpoch: Schema.NullOr(Schema.String),
      }),
    },
  },
}).createMachine({
  id: "communication-pump-recovery",
  version: "1",
  initial: "recorded",
  context: ({ input }) => input,
  states: {
    recorded: {
      on: {
        EXHAUSTED: ({ context, event }) => ({
          context: { ...context, recovery: event.recovery },
        }),
        RETRY: ({ context, event }) =>
          context.recovery?.epoch === event.epoch && event.now < event.deadline
            ? {
                context: {
                  ...context,
                  recovery: null,
                  retiredEpoch:
                    event.pumpEpoch === event.epoch
                      ? event.pumpEpoch
                      : context.retiredEpoch,
                },
              }
            : {},
      },
    },
  },
})
export function readMailboxRecoveryState(value: unknown) {
  if (typeof value === "object" && value !== null && "recovery" in value)
    return Schema.decodeUnknownSync(MailboxRecoveryState)(value)
  // The initial summary-only form remains compatible; no failed epoch resets.
  return Schema.decodeUnknownSync(MailboxRecoveryState)({
    schemaVersion: 1,
    workflowVersion: 1,
    retiredEpoch: null,
    recovery:
      value === undefined || value === null
        ? null
        : Schema.decodeUnknownSync(MailboxRecovery)(value),
  })
}
export function readMailboxRecovery(value: unknown) {
  return readMailboxRecoveryState(value).recovery
}
export function transitionMailboxRecovery(
  prior: unknown,
  event:
    | { type: "EXHAUSTED"; recovery: typeof MailboxRecovery.Type }
    | {
        type: "RETRY"
        epoch: string
        now: number
        deadline: number
        pumpEpoch: string | null
      }
) {
  const [next, effects] = transition(
    communicationRecoveryMachine,
    communicationRecoveryMachine.resolveState({
      value: "recorded",
      context: readMailboxRecoveryState(prior),
    }),
    event
  )
  if (effects.some((effect) => effect.type !== "@xstate.terminate"))
    throw new Error("Communication recovery decisions must be synchronous.")
  return readMailboxRecoveryState(next.context)
}
