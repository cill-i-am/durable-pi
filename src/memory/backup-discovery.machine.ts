import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import {
  describeExecutableEffect,
  transition,
  type EventFromLogic,
} from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { BackupClaim } from "./backup.machine"
const time = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const token = Schema.String.check(Schema.isMinLength(1))
export const BackupDiscovery = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  token,
  deadline: time,
})
export const readBackupDiscovery = Schema.decodeUnknownSync(BackupDiscovery)
const Command = Schema.Union([
  Schema.Struct({ type: Schema.Literal("wake") }),
  Schema.Struct({ type: Schema.Literal("schedule"), at: time }),
])
const machine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: BackupDiscovery,
    context: BackupDiscovery,
    events: {
      ARM: Schema.Struct({ token, deadline: time }),
      OBSERVE: Schema.Struct({ now: time }),
    },
    emitted: { wake: Schema.Struct({}), schedule: Schema.Struct({ at: time }) },
  },
}).createMachine({
  id: "memory-backup-discovery",
  version: "1",
  initial: "retained",
  context: ({ input }) => input,
  states: {
    retained: {
      on: {
        ARM: ({ context, event }) => ({
          context: {
            ...context,
            token: event.token,
            deadline: Math.max(context.deadline, event.deadline),
          },
        }),
        OBSERVE: ({ context, event }, enq) => {
          enq.emit({ type: "wake" })
          if (context.deadline > event.now)
            enq.emit({ type: "schedule", at: context.deadline })
        },
      },
    },
  },
})
function decide(
  state: typeof BackupDiscovery.Type,
  event: EventFromLogic<typeof machine>
) {
  const [next, effects] = transition(
    machine,
    machine.resolveState({ value: "retained", context: state }),
    event
  )
  return {
    state: readBackupDiscovery(next.context),
    commands: effects.flatMap((effect) => {
      if (effect.type === "@xstate.terminate") return []
      const descriptor = describeExecutableEffect(effect)
      if (descriptor.kind === "emit")
        return [Schema.decodeUnknownSync(Command)(descriptor.event)]
      throw new Error(`Unsupported backup discovery effect: ${effect.type}`)
    }),
  }
}
export const armBackupDiscovery = (
  prior: unknown,
  deadline: number,
  token: string
) =>
  decide(
    prior === undefined
      ? { schemaVersion: 1, workflowVersion: 1, token, deadline: 0 }
      : readBackupDiscovery(prior),
    { type: "ARM", deadline, token }
  ).state
export const observeBackupDiscovery = (state: unknown, now: number) =>
  decide(readBackupDiscovery(state), { type: "OBSERVE", now }).commands

export const BackupSchedulerRecovery = Schema.Struct({
  epoch: token,
  failedAt: time,
  message: Schema.String,
})
export type BackupSchedulerRecovery = typeof BackupSchedulerRecovery.Type
export const BackupController = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  phase: Schema.Literals(["available", "exhausted"]),
  retiredToken: Schema.NullOr(token),
  recovery: Schema.NullOr(BackupSchedulerRecovery),
  claim: Schema.optionalKey(Schema.NullOr(BackupClaim)),
})
export type BackupController = typeof BackupController.Type
export const readBackupController = Schema.decodeUnknownSync(BackupController)
export const initialBackupController = (): BackupController => ({
  schemaVersion: 1,
  workflowVersion: 1,
  phase: "available",
  retiredToken: null,
  recovery: null,
  claim: null,
})
const controller = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: BackupController,
    context: BackupController,
    events: {
      EXHAUST: Schema.Struct({
        token,
        recovery: BackupSchedulerRecovery,
        claim: Schema.NullOr(BackupClaim),
      }),
      SETTLED: Schema.Struct({ attemptId: token }),
      ATTACH: Schema.Struct({ claim: BackupClaim }),
      RECOVER: Schema.Struct({ epoch: token }),
    },
  },
}).createMachine({
  id: "memory-backup-controller",
  version: "1",
  initial: "available",
  context: ({ input }) => input,
  on: {
    ATTACH: ({ context, event }) =>
      context.phase === "exhausted" && !context.claim
        ? { context: { ...context, claim: event.claim } }
        : undefined,
  },
  states: {
    available: {
      on: {
        SETTLED: ({ context, event }) =>
          context.claim?.attemptId === event.attemptId
            ? { context: { ...context, claim: null } }
            : undefined,
        EXHAUST: ({ context, event }) => ({
          target: "exhausted",
          context: {
            ...context,
            phase: "exhausted",
            retiredToken: event.token,
            recovery: event.recovery,
            claim: event.claim,
          },
        }),
      },
    },
    exhausted: {
      on: {
        RECOVER: ({ context, event }) =>
          event.epoch === context.recovery?.epoch
            ? {
                target: "available",
                context: { ...context, phase: "available" },
              }
            : undefined,
      },
    },
  },
})
export function decideBackupController(
  state: BackupController,
  event: EventFromLogic<typeof controller>
) {
  const [next, effects] = transition(
    controller,
    controller.resolveState({ value: state.phase, context: state }),
    event
  )
  if (effects.length) throw new Error("Unexpected backup controller effect")
  return readBackupController(next.context)
}
