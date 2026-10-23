import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import {
  describeExecutableEffect,
  transition,
  type ExecutableEffect,
  type EventFromLogic,
} from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { WORKSPACE_RECOVERY_MS } from "./preparation.machine"

const timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const token = Schema.String.check(Schema.isNonEmpty())
const Claim = Schema.Struct({
  id: token,
  kind: Schema.Literals(["document", "video"]),
  attemptId: token,
  attempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
})
export const WorkspaceDiscovery = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  token,
  armedUntil: timestamp,
})
const Command = Schema.Union([
  Schema.Struct({ type: Schema.Literal("wake") }),
  Schema.Struct({ type: Schema.Literal("reschedule"), at: timestamp }),
])

/** Admission discovery has its own finite lease, independent of a live pump. */
export const workspaceDiscoveryMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: WorkspaceDiscovery,
    context: WorkspaceDiscovery,
    events: {
      ARM: Schema.Struct({ deadline: timestamp, token }),
      OBSERVED: Schema.Struct({ now: timestamp, pending: Schema.Boolean }),
    },
    emitted: {
      wake: Schema.Struct({}),
      reschedule: Schema.Struct({ at: timestamp }),
    },
  },
}).createMachine({
  id: "workspace-discovery",
  version: "1",
  initial: "armed",
  context: ({ input }) => input,
  states: {
    armed: {
      on: {
        ARM: ({ context, event }) => ({
          context: {
            ...context,
            token: event.token,
            armedUntil: Math.max(context.armedUntil, event.deadline),
          },
        }),
        OBSERVED: ({ context, event }, enq) => {
          if (event.pending) enq.emit({ type: "wake" })
          if (context.armedUntil > event.now)
            enq.emit({ type: "reschedule", at: context.armedUntil })
          else return { target: "settled" }
        },
      },
    },
    settled: { type: "final" },
  },
})
function commands(effects: readonly ExecutableEffect[]) {
  return effects.flatMap((effect) => {
    if (effect.type === "@xstate.terminate") return []
    const descriptor = describeExecutableEffect(effect)
    if (descriptor.kind === "emit")
      return [Schema.decodeUnknownSync(Command)(descriptor.event)]
    throw new Error(`Unsupported Workspace discovery effect: ${effect.type}`)
  })
}
export const readWorkspaceDiscovery =
  Schema.decodeUnknownSync(WorkspaceDiscovery)
export function armWorkspaceDiscovery(
  prior: unknown,
  deadline: number,
  token: string
) {
  const context = readWorkspaceDiscovery(
    prior ?? {
      schemaVersion: 1,
      workflowVersion: 1,
      token,
      armedUntil: deadline,
    }
  )
  const [next, effects] = transition(
    workspaceDiscoveryMachine,
    workspaceDiscoveryMachine.resolveState({ value: "armed", context }),
    { type: "ARM", deadline, token }
  )
  commands(effects)
  return readWorkspaceDiscovery(next.context)
}
export function observeWorkspaceDiscovery(
  payload: unknown,
  observation: { now: number; pending: boolean }
) {
  const [, effects] = transition(
    workspaceDiscoveryMachine,
    workspaceDiscoveryMachine.resolveState({
      value: "armed",
      context: readWorkspaceDiscovery(payload),
    }),
    { type: "OBSERVED", ...observation }
  )
  return commands(effects)
}

export const WorkspacePump = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  token,
  phase: Schema.Literals(["dispatch", "cleanup", "retired"]),
  claim: Schema.NullOr(Claim),
  cleanupAt: timestamp,
  finalBatch: Schema.Boolean,
})
export type WorkspacePump = typeof WorkspacePump.Type
export const readWorkspacePump = Schema.decodeUnknownSync(WorkspacePump)

/** This is a receipt for one Lifecycle budget, not a second preparation engine.
 * Once failure joins, this budget may only persist its exact terminal claim.
 * One final cleanup-only budget runs after the domain recovery deadline. */
export const workspacePumpMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: WorkspacePump,
    context: WorkspacePump,
    events: {
      CLAIMED: Schema.Struct({ claim: Claim }),
      FAILED: Schema.Struct({ now: timestamp }),
      DEFER_CLEANUP: Schema.Struct({ at: timestamp }),
      EXHAUSTED: Schema.Struct({}),
      SAVED: Schema.Struct({}),
      TRANSFER: Schema.Struct({ token }),
    },
  },
}).createMachine({
  id: "workspace-pump",
  version: "1",
  initial: "dispatch",
  context: ({ input }) => input,
  states: {
    dispatch: {
      on: {
        CLAIMED: ({ context, event }) => ({
          context: { ...context, claim: event.claim },
        }),
        FAILED: ({ context, event }) => ({
          target: "cleanup",
          context: {
            ...context,
            phase: "cleanup",
            cleanupAt: event.now + WORKSPACE_RECOVERY_MS,
          },
        }),
      },
    },
    cleanup: {
      on: {
        TRANSFER: ({ context, event }) => ({
          context: { ...context, token: event.token, finalBatch: true },
        }),
        DEFER_CLEANUP: ({ context, event }) => ({
          context: { ...context, finalBatch: true, cleanupAt: event.at },
        }),
        EXHAUSTED: ({ context }) =>
          context.finalBatch
            ? { target: "retired", context: { ...context, phase: "retired" } }
            : { context: { ...context, finalBatch: true } },
        SAVED: ({ context }) => ({
          target: "retired",
          context: { ...context, phase: "retired" },
        }),
      },
    },
    retired: { type: "final" },
  },
})
export function decideWorkspacePump(
  payload: unknown,
  event: EventFromLogic<typeof workspacePumpMachine>
): WorkspacePump {
  const context = readWorkspacePump(payload)
  const [next, effects] = transition(
    workspacePumpMachine,
    workspacePumpMachine.resolveState({ value: context.phase, context }),
    event
  )
  for (const effect of effects) {
    if (effect.type !== "@xstate.terminate")
      throw new Error(`Unsupported Workspace pump effect: ${effect.type}`)
  }
  return readWorkspacePump(next.context)
}
