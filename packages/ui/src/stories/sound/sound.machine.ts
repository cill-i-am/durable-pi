import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema, type Scope } from "effect"
import type { EventFromLogic, SnapshotFrom } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

export const SoundCue = Schema.Literals(["complete", "attention"])
export type SoundCue = typeof SoundCue.Type
export const SoundRequest = Schema.Struct({
  receipt: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.isPattern(/\S/)
  ),
  cue: SoundCue,
  outcome: Schema.Literals([
    "confirmed",
    "uncertain",
    "cancelled",
    "navigation",
  ]),
  meaningful: Schema.Boolean,
  actionable: Schema.Boolean,
  repeated: Schema.Boolean,
})
export type SoundRequest = typeof SoundRequest.Type
export class SoundIssue extends Schema.TaggedError<SoundIssue>()("SoundIssue", {
  message: Schema.String,
}) {}
export type SoundPorts = {
  play: (
    request: SoundRequest
  ) => Effect.Effect<"played" | "cancelled", SoundIssue, Scope.Scope>
  cancel: (request: SoundRequest) => Effect.Effect<void>
}
const contextSchema = Schema.Struct({
  seen: Schema.Array(Schema.String),
  request: Schema.NullOr(SoundRequest),
  intent: Schema.Literals(["continue", "mute"]),
  message: Schema.String,
  failure: Schema.Unknown,
})

/** This is a local audition, never an application notification subscription.
 * Every receipt is consumed even when silent; ignored events are never queued. */
export function soundAuditionMachine(ports: SoundPorts) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: contextSchema,
      events: {
        ENABLE: Schema.Struct({}),
        MUTE: Schema.Struct({}),
        HIDE: Schema.Struct({}),
        CANCEL: Schema.Struct({}),
        CUE: SoundRequest,
      },
    },
    actors: {
      cue: createEffectLogic(({ input }: { input: SoundRequest }) =>
        Effect.exit(Effect.scoped(ports.play(input))).pipe(
          Effect.map((exit) => ({ receipt: input.receipt, exit }))
        )
      ),
      cooldown: createEffectLogic(Effect.sleep(2000)),
    },
    actions: {
      cancel: ({ params }: { params?: unknown }) =>
        ports.cancel(Schema.decodeUnknownSync(SoundRequest)(params)),
    },
  }).createMachine({
    id: "sound-audition",
    context: {
      seen: [],
      request: null,
      intent: "mute",
      message: "Muted. Enable to audition the cues.",
      failure: null,
    },
    initial: "muted",
    on: {
      CUE: ({ context, event }) => ({
        context: context.seen.includes(event.receipt)
          ? context
          : { ...context, seen: [...context.seen, event.receipt] },
      }),
    },
    states: {
      muted: {
        on: {
          ENABLE: ({ context }) => ({
            target: "ready",
            context: {
              ...context,
              intent: "continue",
              message: "Enabled for this audition. Choose a cue.",
              failure: null,
            },
          }),
        },
      },
      ready: {
        on: {
          CUE: ({ context, event }) => {
            const unseen = !context.seen.includes(event.receipt)
            const next = unseen
              ? { ...context, seen: [...context.seen, event.receipt] }
              : context
            return unseen &&
              event.outcome === "confirmed" &&
              !event.repeated &&
              (event.cue === "complete" ? event.meaningful : event.actionable)
              ? {
                  target: "active",
                  context: {
                    ...next,
                    request: event,
                    message: "Auditioning…",
                  },
                }
              : { context: next }
          },
          MUTE: silence,
          HIDE: silence,
          CANCEL: silence,
        },
      },
      active: {
        initial: "playing",
        invoke: {
          id: "sound-cue",
          src: "cue",
          input: ({ context }) => context.request!,
          onDone: ({ context, event }) => {
            if (event.output.receipt !== context.request?.receipt) return
            const exit = event.output.exit
            if (Exit.isFailure(exit)) {
              const failed = exit.cause.reasons.find(
                (reason) => reason._tag === "Fail"
              )
              const cleanupFailed =
                Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause)
              return {
                target: cleanupFailed ? "blocked" : "muted",
                context: {
                  ...context,
                  intent: "mute",
                  message: cleanupFailed
                    ? "Audio cleanup could not be confirmed. Reload this audition."
                    : failed?._tag === "Fail"
                      ? failed.error.message
                      : "Audio could not start. Check browser sound permissions, then enable again.",
                  failure: exit.cause,
                },
              }
            }
            const muted =
              context.intent === "mute" || exit.value === "cancelled"
            return {
              target: muted ? "cooldown.muted" : "cooldown.enabled",
              context: {
                ...context,
                intent: muted ? "mute" : "continue",
                message: muted
                  ? "Muted."
                  : "Cue finished. Wait two seconds before the next audition.",
              },
            }
          },
        },
        on: {
          MUTE: stop,
          HIDE: stop,
          CANCEL: stop,
        },
        states: {
          playing: {},
          stopping: {
            entry: (args, enq) => {
              enq(args.actions.cancel, {
                ...args,
                params: args.context.request,
              })
            },
          },
        },
      },
      cooldown: {
        initial: "enabled",
        invoke: {
          src: "cooldown",
          onDone: ({ context }) => ({
            target: context.intent === "mute" ? "muted" : "ready",
            context: {
              ...context,
              message:
                context.intent === "mute"
                  ? "Muted. Enable to audition the cues."
                  : "Ready for another audition.",
            },
          }),
        },
        states: {
          enabled: {
            on: { MUTE: silence, HIDE: silence, CANCEL: silence },
          },
          muted: {
            on: {
              ENABLE: ({ context }) => ({
                target: "enabled",
                context: {
                  ...context,
                  intent: "continue",
                  message: "Enabled. Waiting for the next audition.",
                },
              }),
            },
          },
        },
      },
      blocked: {},
    },
  })
}

// Shared machine transitions, not an independent cancellation controller.
const silence = ({ context }: { context: typeof contextSchema.Type }) => ({
  target: "muted",
  context: { ...context, intent: "mute" as const, message: "Muted." },
})
function stop(args: { context: typeof contextSchema.Type }) {
  return {
    target: ".stopping",
    context: { ...args.context, intent: "mute" as const, message: "Muting…" },
  }
}
export type SoundMachine = ReturnType<typeof soundAuditionMachine>
export type SoundEvent = EventFromLogic<SoundMachine>
export type SoundSnapshot = SnapshotFrom<SoundMachine>
export function soundView(snapshot?: SoundSnapshot) {
  const muted =
    !snapshot ||
    snapshot.matches("muted") ||
    snapshot.matches("blocked") ||
    snapshot.context.intent === "mute"
  return {
    muted,
    ready: !!snapshot,
    canPlay: !!snapshot?.matches("ready"),
    canEnable:
      !!snapshot &&
      (snapshot.matches("muted") || snapshot.matches({ cooldown: "muted" })),
    message: snapshot?.context.message ?? "Muted. Enable to audition the cues.",
  }
}
