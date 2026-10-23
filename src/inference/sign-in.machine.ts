import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { transition } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

const id = Schema.String.check(Schema.isMinLength(1))
export const SignInState = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  id,
  owner: id,
  membershipId: id,
  expiresAt: Schema.Number.check(Schema.isFinite()),
  phase: Schema.Literals([
    "waiting",
    "exchanging",
    "connected",
    "unconfirmed",
    "cancelled",
    "expired",
  ]),
})
export type SignInState = typeof SignInState.Type
const identity = Schema.Struct({ id, owner: id, membershipId: id })
const SignInEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("CLAIM"),
    ...identity.fields,
    now: Schema.Number.check(Schema.isFinite()),
  }),
  Schema.Struct({
    type: Schema.Literals(["CONNECTED", "UNCERTAIN", "CANCEL", "EXPIRE"]),
    ...identity.fields,
  }),
])
export const signInMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: SignInState,
    events: {
      CLAIM: Schema.Struct({ ...identity.fields, now: Schema.Number }),
      CONNECTED: identity,
      UNCERTAIN: identity,
      CANCEL: identity,
      EXPIRE: identity,
    },
  },
}).createMachine({
  id: "model-sign-in",
  version: "1",
  initial: "waiting",
  context: () => ({
    schemaVersion: 1,
    workflowVersion: 1,
    id: "",
    owner: "",
    membershipId: "",
    expiresAt: 0,
    phase: "waiting",
  }),
  states: {
    waiting: {
      on: {
        CLAIM: ({ context, event }) =>
          context.id === event.id &&
          context.owner === event.owner &&
          context.membershipId === event.membershipId &&
          context.expiresAt > event.now
            ? {
                target: "exchanging",
                context: { ...context, phase: "exchanging" },
              }
            : undefined,
        CANCEL: ({ context, event }) =>
          context.id === event.id &&
          context.owner === event.owner &&
          context.membershipId === event.membershipId
            ? {
                target: "cancelled",
                context: { ...context, phase: "cancelled" },
              }
            : undefined,
        EXPIRE: ({ context, event }) =>
          context.id === event.id &&
          context.owner === event.owner &&
          context.membershipId === event.membershipId
            ? { target: "expired", context: { ...context, phase: "expired" } }
            : undefined,
      },
    },
    exchanging: {
      on: {
        CONNECTED: ({ context, event }) =>
          context.id === event.id &&
          context.owner === event.owner &&
          context.membershipId === event.membershipId
            ? {
                target: "connected",
                context: { ...context, phase: "connected" },
              }
            : undefined,
        UNCERTAIN: ({ context, event }) =>
          context.id === event.id &&
          context.owner === event.owner &&
          context.membershipId === event.membershipId
            ? {
                target: "unconfirmed",
                context: { ...context, phase: "unconfirmed" },
              }
            : undefined,
      },
    },
    connected: {},
    unconfirmed: {},
    cancelled: {},
    expired: {},
  },
})
export function advanceSignIn(
  saved: SignInState,
  event:
    | {
        type: "CLAIM"
        id: string
        owner: string
        membershipId: string
        now: number
      }
    | {
        type: "CONNECTED" | "UNCERTAIN" | "CANCEL" | "EXPIRE"
        id: string
        owner: string
        membershipId: string
      }
): SignInState {
  const context = Schema.decodeUnknownSync(SignInState)(saved)
  const [next] = transition(
    signInMachine,
    signInMachine.resolveState({ value: context.phase, context }),
    Schema.decodeUnknownSync(SignInEvent)(event)
  )
  return Schema.decodeUnknownSync(SignInState)(next.context)
}
