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

import { AccessConflict, AccessDenied, ToolPolicy } from "./contracts"
import { requirePolicy, validateResult } from "./domain"
import { ToolOperation, type ToolIntent } from "./ledger"

const counter = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
)
const { status: Status, ...fields } = ToolOperation.fields
const Context = Schema.Struct({
  ...fields,
  revision: counter,
  grantRevision: counter,
})
type Context = typeof Context.Type
const Decision = Schema.Struct({
  approve: Schema.Boolean,
  expectedRevision: counter,
  remember: Schema.NullOr(Schema.Struct({ expectedPolicyRevision: counter })),
  policy: Schema.NullOr(ToolPolicy),
})
const Claim = Schema.Struct({
  policy: ToolPolicy,
  recoverable: Schema.Boolean,
  runnable: Schema.Boolean,
  now: Schema.Number,
})
type Claim = typeof Claim.Type
const Dispatch = Schema.Union([
  Schema.Literals(["pending", "execute"]),
  Schema.Struct({ result: Schema.String }),
])
const Command = Schema.Union([
  Schema.Struct({ type: Schema.Literal("dispatch"), decision: Dispatch }),
  Schema.Struct({ type: Schema.Literal("reject"), message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("grant"), revision: counter }),
])
export type OperationCommand = typeof Command.Type

function assertRunnable(runnable: boolean) {
  if (!runnable)
    throw new AccessDenied({
      message: "This reply has stopped or its bot is archived.",
    })
}
function assertClaim(event: Claim) {
  assertRunnable(event.runnable)
  if (event.policy.mode === "deny")
    throw new AccessDenied({ message: "Tool access has been revoked." })
}

const setup = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: Context,
    context: Context,
    events: {
      BEGIN: Schema.Struct({
        intent: Schema.Struct({
          id: Schema.String,
          turnId: Schema.String,
          tool: Schema.String,
          input: Schema.String,
        }),
        policy: Schema.NullOr(ToolPolicy),
        pending: counter,
        runnable: Schema.Boolean,
      }),
      DECIDE: Decision,
      CLAIM: Claim,
      FINISH: Schema.Struct({ result: Schema.String }),
      EXPIRE: Schema.Struct({ now: Schema.Number }),
      CANCEL: Schema.Struct({}),
      REVOKE: Schema.Struct({}),
    },
    emitted: {
      dispatch: Schema.Struct({ decision: Dispatch }),
      reject: Schema.Struct({ message: Schema.String }),
      grant: Schema.Struct({ revision: counter }),
    },
  },
})

function approvalIdentity(event: typeof Decision.Type) {
  if (event.remember && !event.approve)
    throw new AccessConflict({
      message: "Only an approval can allow future calls.",
    })
  return JSON.stringify({
    approve: event.approve,
    expectedRevision: event.expectedRevision,
    policyRevision: event.remember?.expectedPolicyRevision ?? null,
  })
}

// One handler per approval state also admits idempotent decisions after completion.
// A replay never re-grants a policy which has subsequently been changed.
const decide =
  (status: typeof Status.Type) =>
  (
    { context, event }: { context: Context; event: typeof Decision.Type },
    enq: { emit: (command: OperationCommand) => void }
  ) => {
    const identity = approvalIdentity(event)
    if (status !== "pending" && context.decision === identity) return
    if (
      !event.remember &&
      !context.decision &&
      status === (event.approve ? "approved" : "denied") &&
      context.revision === event.expectedRevision + 1
    )
      return
    if (status !== "pending" || context.revision !== event.expectedRevision)
      throw new AccessConflict({
        message: "This approval has already ended. Refresh the conversation.",
      })
    const policy = requirePolicy(event.policy ?? undefined)
    if (event.approve && policy.mode === "deny")
      throw new AccessDenied({
        message: "This tool has been denied. Update its access policy first.",
      })
    if (
      event.remember &&
      policy.revision !== event.remember.expectedPolicyRevision
    )
      throw new AccessConflict({
        message: "Tool access changed. Reload before allowing future calls.",
      })
    const rememberGrant = event.remember && policy.mode !== "allow"
    const grantRevision = policy.revision + (rememberGrant ? 1 : 0)
    if (rememberGrant) enq.emit({ type: "grant", revision: grantRevision })
    return {
      target: event.approve ? "approved" : "denied",
      context: {
        ...context,
        grantRevision,
        decision: identity,
        revision: context.revision + 1,
      },
    }
  }
const openEvents = {
  EXPIRE: ({ context, event }: { context: Context; event: { now: number } }) =>
    event.now >= context.expiresAt
      ? {
          target: "expired",
          context: { ...context, revision: context.revision + 1 },
        }
      : undefined,
  CANCEL: ({ context }: { context: Context }) => ({
    target: "cancelled",
    context: { ...context, revision: context.revision + 1 },
  }),
  REVOKE: ({ context }: { context: Context }) => ({
    target: "denied",
    context: { ...context, revision: context.revision + 1 },
  }),
}
const claimOpen =
  (approved: boolean) =>
  (
    { context, event }: { context: Context; event: Claim },
    enq: { emit: (command: OperationCommand) => void }
  ) => {
    assertClaim(event)
    if (event.now >= context.expiresAt) {
      enq.emit({ type: "reject", message: "This tool request is expired." })
      return {
        target: "expired",
        context: { ...context, revision: context.revision + 1 },
      }
    }
    if (
      event.policy.mode === "ask" &&
      (!approved || context.grantRevision !== event.policy.revision)
    ) {
      enq.emit({ type: "dispatch", decision: "pending" })
      if (!approved && context.grantRevision === event.policy.revision) return
      return {
        target: "pending",
        context: {
          ...context,
          grantRevision: event.policy.revision,
          revision: context.revision + 1,
        },
      }
    }
    enq.emit({ type: "dispatch", decision: "execute" })
    return {
      target: "running",
      context: {
        ...context,
        grantRevision: event.policy.revision,
        revision: context.revision + 1,
      },
    }
  }
const closed = (
  status: "denied" | "cancelled" | "expired" | "interrupted"
) => ({
  on: {
    DECIDE: decide(status),
    CLAIM: ({ event }: { event: Claim }) => {
      assertClaim(event)
      throw new AccessDenied({ message: `This tool request is ${status}.` })
    },
  },
})

/** SQL domain data is the only durable state; these synchronous decisions run
 * inside the existing shared application/Pi transaction, never in a mailbox. */
export const operationMachine = setup.createMachine({
  id: "access-operation",
  version: "1",
  context: ({ input }) => input,
  initial: "unadmitted",
  on: {
    BEGIN: ({ context, event }) => {
      assertRunnable(event.runnable)
      if (
        context.id !== event.intent.id ||
        context.turnId !== event.intent.turnId ||
        context.tool !== event.intent.tool ||
        context.input !== event.intent.input
      )
        throw new AccessConflict({
          message: "Tool operation identity does not match.",
        })
    },
  },
  states: {
    unadmitted: {
      on: {
        BEGIN: ({ context, event }) => {
          assertRunnable(event.runnable)
          const policy = requirePolicy(event.policy ?? undefined)
          if (policy.mode === "deny")
            throw new AccessDenied({
              message: "This tool is denied by the bot's access policy.",
            })
          if (context.input.length > 64_000)
            throw new AccessDenied({
              message: "Tool arguments exceed the approval limit.",
            })
          if (event.pending >= 20)
            throw new AccessDenied({
              message:
                "Resolve the pending approvals before requesting more tools.",
            })
          return {
            target: policy.mode === "ask" ? "pending" : "approved",
            context: { ...context, grantRevision: policy.revision },
          }
        },
      },
    },
    pending: {
      on: { ...openEvents, DECIDE: decide("pending"), CLAIM: claimOpen(false) },
    },
    approved: {
      on: { ...openEvents, DECIDE: decide("approved"), CLAIM: claimOpen(true) },
    },
    running: {
      on: {
        DECIDE: decide("running"),
        CLAIM: ({ context, event }, enq) => {
          assertClaim(event)
          if (!event.recoverable) {
            enq.emit({
              type: "reject",
              message:
                "This tool was interrupted after it started. Its outcome is unknown; check before retrying.",
            })
            return {
              target: "interrupted",
              context: { ...context, revision: context.revision + 1 },
            }
          }
          if (
            context.expiresAt <= event.now ||
            context.grantRevision !== event.policy.revision
          ) {
            const expired = context.expiresAt <= event.now
            enq.emit({
              type: "reject",
              message: expired
                ? "This interrupted tool request has expired. Read current state before requesting a new change."
                : "Tool access changed after dispatch. Read current state before requesting a new change.",
            })
            return {
              target: expired ? "expired" : "denied",
              context: { ...context, revision: context.revision + 1 },
            }
          }
          enq.emit({ type: "dispatch", decision: "execute" })
          return { context: { ...context, revision: context.revision + 1 } }
        },
        FINISH: ({ context, event }) => {
          validateResult(event.result)
          return {
            target: "done",
            context: {
              ...context,
              result: event.result,
              revision: context.revision + 1,
            },
          }
        },
      },
    },
    done: {
      on: {
        DECIDE: decide("done"),
        CLAIM: ({ context, event }, enq) => {
          assertClaim(event)
          if (context.result === null)
            throw new AccessDenied({ message: "This tool request is done." })
          enq.emit({ type: "dispatch", decision: { result: context.result } })
        },
      },
    },
    denied: closed("denied"),
    cancelled: closed("cancelled"),
    expired: closed("expired"),
    interrupted: closed("interrupted"),
  },
})

export type OperationEvent = EventFromLogic<typeof operationMachine>

export function operationCommands(
  effects: readonly ExecutableEffect[]
): OperationCommand[] {
  return effects.map((effect) => {
    const descriptor = describeExecutableEffect(effect)
    if (descriptor.kind === "emit")
      return Schema.decodeUnknownSync(Command)(descriptor.event)
    throw new Error(`Unsupported Access operation effect: ${effect.type}`)
  })
}

export function advanceOperation(saved: unknown, event: OperationEvent) {
  const { status, ...context } = Schema.decodeUnknownSync(ToolOperation)(saved)
  const snapshot = operationMachine.resolveState({
    value: status,
    context: Schema.decodeUnknownSync(Context)(context),
  })
  return step(snapshot, event)
}

export function beginOperation(
  input: ToolIntent,
  now: number,
  event: Extract<OperationEvent, { type: "BEGIN" }>
) {
  const [snapshot, effects] = initialTransition(operationMachine, {
    ...input,
    createdAt: now,
    expiresAt: now + 15 * 60_000,
    schemaVersion: 1,
    workflowVersion: 1,
    revision: 0,
    grantRevision: 0,
    decision: null,
    result: null,
  })
  operationCommands(effects)
  return step(snapshot, event).operation
}
function step(
  snapshot: ReturnType<typeof operationMachine.resolveState>,
  event: OperationEvent
) {
  const [next, effects] = transition(operationMachine, snapshot, event)
  const commands = operationCommands(effects)
  return {
    operation: Schema.decodeUnknownSync(ToolOperation)({
      ...next.context,
      status: next.value,
    }),
    commands,
  }
}
