import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { transition } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

export const CapacityLease = Schema.Struct({
  owner: Schema.String,
  epoch: Schema.Number,
  issuedAt: Schema.Number,
})
export type CapacityLease = typeof CapacityLease.Type
export interface CapacityState {
  next: number
  leases: CapacityLease[]
}
const state = Schema.Struct({
  next: Schema.Number,
  leases: Schema.Array(CapacityLease),
})
export const capacityLedgerMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Schema.Struct({
      ledger: state,
      lease: Schema.NullOr(CapacityLease),
      released: Schema.Boolean,
    }),
    events: {
      ACQUIRE: Schema.Struct({ owner: Schema.String, now: Schema.Number }),
      RELEASE: Schema.Struct({ owner: Schema.String, epoch: Schema.Number }),
    },
  },
}).createMachine({
  id: "terminal-capacity-ledger",
  initial: "available",
  context: { ledger: { next: 1, leases: [] }, lease: null, released: false },
  on: {
    ACQUIRE: ({ context, event }) => {
      const old = context.ledger
      const existing = old.leases.find((lease) => lease.owner === event.owner)
      if (existing) return { context: { ...context, lease: existing } }
      if (old.leases.length >= 4)
        return { target: ".full", context: { ...context, lease: null } }
      if (!Number.isSafeInteger(old.next + 1))
        throw new Error("Terminal capacity epoch exhausted")
      const lease = { owner: event.owner, epoch: old.next, issuedAt: event.now }
      const ledger = { next: old.next + 1, leases: [...old.leases, lease] }
      return {
        target: ledger.leases.length < 4 ? ".available" : ".full",
        context: { ledger, lease, released: false },
      }
    },
    RELEASE: ({ context, event }) => {
      const old = context.ledger
      const released = old.leases.some(
        (lease) => lease.owner === event.owner && lease.epoch === event.epoch
      )
      const ledger = released
        ? {
            ...old,
            leases: old.leases.filter(
              (lease) =>
                lease.owner !== event.owner || lease.epoch !== event.epoch
            ),
          }
        : old
      return {
        target: ledger.leases.length < 4 ? ".available" : ".full",
        context: { ledger, lease: null, released },
      }
    },
  },
  states: { available: {}, full: {} },
})
export function decideCapacity(
  current: CapacityState | undefined,
  event:
    | { type: "ACQUIRE"; owner: string; now: number }
    | { type: "RELEASE"; owner: string; epoch: number }
) {
  const ledger = Schema.decodeUnknownSync(state)(
    current ?? { next: 1, leases: [] }
  )
  if (
    !Number.isSafeInteger(ledger.next) ||
    ledger.next < 1 ||
    ledger.leases.length > 4 ||
    new Set(ledger.leases.map((lease) => lease.owner)).size !==
      ledger.leases.length ||
    new Set(ledger.leases.map((lease) => lease.epoch)).size !==
      ledger.leases.length ||
    ledger.leases.some(
      (lease) =>
        !/^[a-f0-9]{64}$/.test(lease.owner) ||
        !Number.isSafeInteger(lease.epoch) ||
        lease.epoch < 1 ||
        lease.epoch >= ledger.next ||
        !Number.isSafeInteger(lease.issuedAt) ||
        lease.issuedAt < 0
    )
  )
    throw new Error("Invalid terminal capacity ledger")
  const before = capacityLedgerMachine.resolveState({
    value: ledger.leases.length < 4 ? "available" : "full",
    context: { ledger, lease: null, released: false },
  })
  const [next, effects] = transition(capacityLedgerMachine, before, event)
  if (effects.length) throw new Error("Invalid terminal capacity event")
  return {
    state: {
      next: next.context.ledger.next,
      leases: [...next.context.ledger.leases],
    },
    lease: next.context.lease,
    released: next.context.released,
  }
}

/** Reclamation is acknowledged by the old native owner before a lease can be
 * replaced. This scoped attempt never turns age alone into capacity. */
export function capacityAcquisitionMachine<E>(work: {
  allocate: Effect.Effect<CapacityLease | null, E>
  candidates: Effect.Effect<readonly CapacityLease[], E>
  now: Effect.Effect<number>
  retire: (lease: CapacityLease) => Effect.Effect<boolean, E>
  reclaim: (lease: CapacityLease) => Effect.Effect<CapacityLease | null, E>
}) {
  const outcome = Schema.declare(
    (value): value is Exit.Exit<CapacityLease, unknown> => Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        candidates: Schema.Array(CapacityLease),
        index: Schema.Number,
        outcome,
      }),
      events: {},
      output: outcome,
    },
    actors: {
      clock: createEffectLogic(work.now),
      allocate: createEffectLogic(Effect.exit(work.allocate)),
      candidates: createEffectLogic(Effect.exit(work.candidates)),
      retire: createEffectLogic(({ input }: { input: CapacityLease }) =>
        Effect.exit(work.retire(input))
      ),
      reclaim: createEffectLogic(({ input }: { input: CapacityLease }) =>
        Effect.exit(work.reclaim(input))
      ),
    },
  }).createMachine({
    id: "capacity-acquisition",
    initial: "allocating",
    context: {
      candidates: [],
      index: 0,
      outcome: Exit.fail(new Error("All terminal slots are busy")) as Exit.Exit<
        CapacityLease,
        unknown
      >,
    },
    output: ({ context }) => context.outcome,
    states: {
      allocating: {
        invoke: {
          src: "allocate",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : event.output.value
                ? {
                    target: "settled",
                    context: {
                      ...context,
                      outcome: Exit.succeed(event.output.value),
                    },
                  }
                : { target: "listing" },
        },
      },
      listing: {
        invoke: {
          src: "candidates",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : {
                  target: "selecting",
                  context: { ...context, candidates: event.output.value },
                },
        },
      },
      selecting: {
        always: ({ context }) => ({
          target:
            context.index < context.candidates.length ? "checking" : "settled",
        }),
      },
      checking: {
        invoke: {
          src: "clock",
          onDone: ({ context, event }) =>
            event.output - context.candidates[context.index]!.issuedAt >= 60_000
              ? { target: "retiring" }
              : {
                  target: "selecting",
                  context: { ...context, index: context.index + 1 },
                },
        },
      },
      retiring: {
        invoke: {
          src: "retire",
          input: ({ context }) => context.candidates[context.index]!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : event.output.value
                ? { target: "reclaiming" }
                : {
                    target: "selecting",
                    context: { ...context, index: context.index + 1 },
                  },
        },
      },
      reclaiming: {
        invoke: {
          src: "reclaim",
          input: ({ context }) => context.candidates[context.index]!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : event.output.value
                ? {
                    target: "settled",
                    context: {
                      ...context,
                      outcome: Exit.succeed(event.output.value),
                    },
                  }
                : {
                    target: "selecting",
                    context: { ...context, index: context.index + 1 },
                  },
        },
      },
      settled: { type: "final" },
    },
  })
}
