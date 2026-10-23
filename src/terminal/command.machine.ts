import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import {
  initialTransition,
  transition,
  type EventFromLogic,
  type ExecutableEffect,
} from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { CommandRun, TerminalFailure, type CommandInput } from "./contracts"
import { TerminalOccupancy, claimTerminalOccupancy } from "./occupancy.machine"
import type { TerminalAuthority } from "./repository"

export const CommandRecord = Schema.Struct({
  ...CommandRun.fields,
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  attemptId: Schema.String,
  occupancy: TerminalOccupancy,
})
export type CommandRecord = typeof CommandRecord.Type
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
          const denied = event.cancelled || (event.publishing && !event.allowed)
          return {
            target: denied ? "cancelled" : event.result.status,
            context: {
              ...bump(context),
              exitCode: denied ? null : event.result.exitCode,
              error: denied
                ? event.cancelled
                  ? "Cancelled. Workspace recovery uses the last saved checkpoint."
                  : "Bot archived. Workspace recovery uses the last saved checkpoint."
                : event.result.error,
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
export function restoreCommandRecord(saved: unknown): CommandRecord {
  if (typeof saved !== "object" || saved === null)
    throw new Error("Invalid terminal command record")
  if ("schemaVersion" in saved || "workflowVersion" in saved)
    return Schema.decodeUnknownSync(CommandRecord)(saved)
  const legacy = Schema.decodeUnknownSync(CommandRun)(saved)
  const attemptId = `legacy:${legacy.id}`
  return Schema.decodeUnknownSync(CommandRecord)({
    ...legacy,
    schemaVersion: 1,
    workflowVersion: 1,
    revision: 0,
    attemptId,
    occupancy:
      legacy.status === "running"
        ? claimTerminalOccupancy(attemptId)
        : { state: "free", ownerId: null },
  })
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
