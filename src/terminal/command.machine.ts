import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import {
  initialTransition,
  transition,
  type EventFromLogic,
  type ExecutableEffect,
} from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { CommandRecord, restoreCommandRecord } from "./command-record"
import { CommandRun, TerminalFailure, type CommandInput } from "./contracts"
import { claimTerminalOccupancy } from "./occupancy.machine"
import type { TerminalAuthority } from "./repository"
export { CommandRecord, restoreCommandRecord } from "./command-record"

const { status: _, ...fields } = CommandRecord.fields
const Context = Schema.Struct(fields)
const result = Schema.Struct({
  status: Schema.Literals(["succeeded", "failed", "cancelled", "interrupted"]),
  exitCode: CommandRun.fields.exitCode,
  error: CommandRun.fields.error,
})
const bump = (context: typeof Context.Type) => ({
  ...context,
  revision: context.revision + 1,
})
function cancellationError(
  cancelled: boolean,
  publishing: boolean,
  allowed: boolean
) {
  if (cancelled)
    return "Cancelled. Workspace recovery uses the last saved checkpoint."
  if (publishing && !allowed)
    return "Bot archived. Workspace recovery uses the last saved checkpoint."
  return null
}
export const terminalCommandMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: Context,
    context: Context,
    events: {
      ADMIT: Schema.Struct({ stopped: Schema.Boolean, now: Schema.Number }),
      PROGRESS: Schema.Struct({
        attemptId: Schema.String,
        output: Schema.String,
      }),
      FINISH: Schema.Struct({
        attemptId: Schema.String,
        result,
        cancelled: Schema.Boolean,
        publishing: Schema.Boolean,
        allowed: Schema.Boolean,
        savedAt: Schema.NullOr(Schema.Number),
        now: Schema.Number,
      }),
      RECOVER: Schema.Struct({ now: Schema.Number }),
    },
  },
}).createMachine({
  id: "terminal-command",
  version: "1",
  initial: "absent",
  context: ({ input }) => input,
  states: {
    absent: {
      on: {
        ADMIT: ({ context, event }) => ({
          target: event.stopped ? "cancelled" : "running",
          context: {
            ...context,
            finishedAt: event.stopped ? event.now : null,
            error: event.stopped
              ? "Stopped before dispatch. This command was not executed."
              : null,
          },
        }),
      },
    },
    running: {
      on: {
        PROGRESS: ({ context, event }) =>
          context.attemptId === event.attemptId
            ? { context: { ...bump(context), output: event.output } }
            : undefined,
        FINISH: ({ context, event }) => {
          if (context.attemptId !== event.attemptId) return
          const denial = cancellationError(
            event.cancelled,
            event.publishing,
            event.allowed
          )
          const denied = denial !== null
          return {
            target: denied ? "cancelled" : event.result.status,
            context: {
              ...bump(context),
              exitCode: denied ? null : event.result.exitCode,
              error: denial ?? event.result.error,
              finishedAt: event.now,
              savedAt: denied ? null : event.savedAt,
            },
          }
        },
        RECOVER: ({ context, event }) => ({
          target: "interrupted",
          context: {
            ...bump(context),
            finishedAt: event.now,
            error:
              "The runtime restarted. This command was not repeated. Workspace recovery uses the last saved checkpoint.",
          },
        }),
      },
    },
    succeeded: {},
    failed: {},
    cancelled: {},
    interrupted: {},
  },
})
export type CommandEvent = EventFromLogic<typeof terminalCommandMachine>
const supported = (effects: readonly ExecutableEffect[]) => {
  if (effects.length)
    throw new Error(`Unsupported terminal command effect: ${effects[0]!.type}`)
}
export function advanceCommandRecord(
  saved: unknown,
  event: CommandEvent
): CommandRecord {
  const { status, ...context } = restoreCommandRecord(saved)
  const [next, effects] = transition(
    terminalCommandMachine,
    terminalCommandMachine.resolveState({ value: status, context }),
    event
  )
  supported(effects)
  return Schema.decodeUnknownSync(CommandRecord)({
    ...next.context,
    status: next.value,
  })
}
export function newCommandRecord(
  input: CommandInput,
  kind: NonNullable<CommandRun["kind"]>,
  transfer: CommandRun["transfer"],
  authority: TerminalAuthority | undefined,
  count: number,
  stopped: boolean,
  networkUnrestricted: boolean,
  now: number,
  attemptId: string
): CommandRecord {
  if (!authority?.active || authority.revision <= authority.revokedThrough)
    throw new TerminalFailure({ message: "This bot is not active." })
  if (count >= 500)
    throw new TerminalFailure({
      message: "This bot has reached its 500-command history limit.",
    })
  const context: typeof Context.Type = {
    ...input,
    kind,
    ...(transfer ? { transfer } : {}),
    authorityRevision: authority.revision,
    networkUnrestricted,
    output: "",
    exitCode: null,
    error: null,
    createdAt: now,
    finishedAt: null,
    savedAt: null,
    schemaVersion: 1,
    workflowVersion: 1,
    revision: 0,
    attemptId,
    occupancy: stopped
      ? { state: "free", ownerId: null }
      : claimTerminalOccupancy(attemptId),
  }
  const [initial, effects] = initialTransition(terminalCommandMachine, context)
  supported(effects)
  const [next, actions] = transition(terminalCommandMachine, initial, {
    type: "ADMIT",
    stopped,
    now,
  })
  supported(actions)
  return Schema.decodeUnknownSync(CommandRecord)({
    ...next.context,
    status: next.value,
  })
}
