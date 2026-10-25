import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Clock, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

export const LEASE_EXPIRED =
  "The terminal lease expired. Unsaved changes were discarded. Open a new session to continue."
export type LeaseState = { ended: boolean; error: string }
const context = Schema.Struct({
  expiresAt: Schema.Number,
  delay: Schema.Number,
  ended: Schema.Boolean,
  error: Schema.String,
})
export function sessionLeaseMachine(
  renew: Effect.Effect<{ expiresAt: number }, unknown>,
  rejected: (cause: Cause.Cause<unknown>) => string | undefined
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: { input: Schema.Struct({ expiresAt: Schema.Number }), context },
    actors: {
      now: createEffectLogic(Clock.currentTimeMillis),
      expiry: createEffectLogic(({ input }: { input: number }) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => Effect.sleep(Math.max(0, input - now)))
        )
      ),
      delay: createEffectLogic(({ input }: { input: number }) =>
        input > 0 ? Effect.sleep(input) : Effect.void
      ),
      renew: createEffectLogic(
        Effect.gen(function* () {
          const result = yield* Effect.exit(renew)
          return { result, now: yield* Clock.currentTimeMillis }
        })
      ),
    },
  }).createMachine({
    id: "terminal-session-lease",
    initial: "checking",
    context: ({ input }) => ({
      expiresAt: input.expiresAt,
      delay: 0,
      ended: false,
      error: "",
    }),
    states: {
      checking: {
        invoke: {
          src: "now",
          onDone: ({ context, event }) =>
            !Number.isFinite(context.expiresAt) ||
            event.output >= context.expiresAt
              ? {
                  target: "ended",
                  context: { ...context, ended: true, error: LEASE_EXPIRED },
                }
              : { target: "active" },
        },
      },
      active: {
        initial: "waiting",
        invoke: {
          src: "expiry",
          input: ({ context }) => context.expiresAt,
          onDone: ({ context }) => ({
            target: "ended",
            context: { ...context, ended: true, error: LEASE_EXPIRED },
          }),
        },
        states: {
          waiting: {
            invoke: {
              src: "delay",
              input: ({ context }) => context.delay,
              onDone: { target: "renewing" },
            },
          },
          renewing: {
            invoke: {
              src: "renew",
              onDone: ({ context, event }) => {
                const { result, now } = event.output
                if (
                  now >= context.expiresAt ||
                  !Number.isFinite(context.expiresAt)
                )
                  return {
                    target: "#terminal-session-lease.ended",
                    context: { ...context, ended: true, error: LEASE_EXPIRED },
                  }
                if (Exit.isFailure(result)) {
                  const terminal = Cause.hasDies(result.cause)
                    ? "The terminal lease could not be maintained. Close and reopen the panel."
                    : rejected(result.cause)
                  return terminal
                    ? {
                        target: "#terminal-session-lease.ended",
                        context: { ...context, ended: true, error: terminal },
                      }
                    : {
                        target: "#terminal-session-lease.active",
                        reenter: true,
                        context: {
                          ...context,
                          delay: 2000,
                          error:
                            "Connection interrupted. Retrying within the current terminal lease…",
                        },
                      }
                }
                return !Number.isFinite(result.value.expiresAt) ||
                  result.value.expiresAt <= now
                  ? {
                      target: "#terminal-session-lease.ended",
                      context: {
                        ...context,
                        ended: true,
                        error: LEASE_EXPIRED,
                      },
                    }
                  : {
                      target: "#terminal-session-lease.active",
                      reenter: true,
                      context: {
                        ...context,
                        delay: 10000,
                        expiresAt: result.value.expiresAt,
                        error: "",
                      },
                    }
              },
            },
          },
        },
      },
      ended: { type: "final" },
    },
  })
}
