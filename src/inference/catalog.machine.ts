import { setupEffect } from "@xstate/effect"
import { Cause, Deferred, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { ModelCatalog, ModelUnavailable } from "./policy"

/** The existing model-catalog-v1 payload remains the sole persisted state. */
export const CatalogSnapshot = Schema.Struct({
  identity: Schema.String,
  verifiedAt: Schema.Number,
  retryAt: Schema.Number,
  failures: Schema.Number,
  value: ModelCatalog,
})
export type CatalogSnapshot = typeof CatalogSnapshot.Type
export const catalogUnavailable = (message: string): ModelCatalog => ({
  models: [],
  checkedAt: null,
  error: message,
  usage: "ChatGPT plan usage",
})
const failure = Schema.declare(
  (value): value is Cause.Cause<ModelUnavailable> => Cause.isCause(value)
)
const Answer = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ack") }),
  Schema.Struct({ kind: Schema.Literal("restore") }),
  Schema.Struct({ kind: Schema.Literal("forward") }),
  Schema.Struct({ kind: Schema.Literal("refresh"), identity: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("failed"), cause: failure }),
  Schema.Struct({
    kind: Schema.Literal("value"),
    value: ModelCatalog,
    background: Schema.UndefinedOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("candidate"),
    value: CatalogSnapshot,
    error: Schema.UndefinedOr(ModelUnavailable),
  }),
])
export type CatalogAnswer = typeof Answer.Type
export type CatalogReply = Deferred.Deferred<CatalogAnswer>
const reply = Schema.declare((value): value is CatalogReply =>
  Deferred.isDeferred(value)
)
const response = Schema.Struct({ reply, answer: Answer })
const context = Schema.Struct({
  saved: Schema.UndefinedOr(CatalogSnapshot),
  restored: Schema.Boolean,
  closed: Schema.Boolean,
  background: Schema.Array(Schema.String),
  failure: Schema.UndefinedOr(failure),
  cleanup: Schema.UndefinedOr(failure),
})
type Context = typeof context.Type

function readDecision(
  context: Context,
  identity: string | null,
  now: number
): {
  phase:
    | "closed"
    | "failed"
    | "forwarding"
    | "unrestored"
    | "fresh"
    | "stale"
    | "cooldown"
    | "refreshing"
  answer: CatalogAnswer
} {
  if (context.closed)
    return {
      phase: "closed",
      answer: { kind: "failed", cause: Cause.interrupt(0) },
    }
  if (context.failure)
    return {
      phase: "failed",
      answer: { kind: "failed", cause: context.failure },
    }
  if (!identity) return { phase: "forwarding", answer: { kind: "forward" } }
  if (!context.restored)
    return { phase: "unrestored", answer: { kind: "restore" } }
  const current =
    context.saved?.identity === identity ? context.saved : undefined
  const age = current ? now - current.verifiedAt : Infinity
  if (current && age >= 0 && !current.value.error && age < 3_600_000)
    return {
      phase: age < 300_000 ? "fresh" : "stale",
      answer: {
        kind: "value",
        value: current.value,
        background:
          age >= 300_000 &&
          now >= current.retryAt &&
          !context.background.includes(identity)
            ? identity
            : undefined,
      },
    }
  if (current && now < current.retryAt)
    return {
      phase: "cooldown",
      answer: {
        kind: "value",
        value: current.value.error
          ? current.value
          : catalogUnavailable(
              "Model catalog refresh is temporarily unavailable. Retry shortly."
            ),
        background: undefined,
      },
    }
  return { phase: "refreshing", answer: { kind: "refresh", identity } }
}
const Outcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("success"), value: ModelCatalog }),
  Schema.Struct({
    kind: Schema.Literal("rejection"),
    error: Schema.toType(ModelUnavailable),
  }),
])
function publication(
  saved: CatalogSnapshot | undefined,
  identity: string,
  now: number,
  outcome: typeof Outcome.Type
): CatalogAnswer {
  if (outcome.kind === "success" && !outcome.value.error)
    return {
      kind: "candidate",
      value: {
        identity,
        verifiedAt: now,
        retryAt: now,
        failures: 0,
        value: outcome.value,
      },
      error: undefined,
    }
  const error =
    outcome.kind === "rejection"
      ? outcome.error
      : new ModelUnavailable({ message: outcome.value.error! })
  const old = saved?.identity === identity ? saved : undefined
  const failures = Math.min((old?.failures ?? 0) + 1, 6)
  const retryAt = now + Math.min(1_000 * 2 ** failures, 60_000)
  return {
    kind: "candidate",
    error,
    value:
      error.reason === "transient" && old && !old.value.error
        ? { ...old, retryAt, failures }
        : {
            identity,
            verifiedAt: now,
            retryAt,
            failures,
            value: catalogUnavailable(error.message),
          },
  }
}

/** Read admission and retry progression only; Effect Cache owns actual lookups. */
export const catalogMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context,
    events: {
      CLOSE: Schema.Struct({ reply }),
      READ: Schema.Struct({
        identity: Schema.NullOr(Schema.String),
        now: Schema.Number,
        reply,
      }),
      RESTORE: Schema.Struct({
        saved: Schema.UndefinedOr(CatalogSnapshot),
        reply,
      }),
      OUTCOME: Schema.Struct({
        identity: Schema.String,
        now: Schema.Number,
        outcome: Outcome,
        reply,
      }),
      COMMIT: Schema.Struct({ saved: CatalogSnapshot, reply }),
      FAILED: Schema.Struct({ cause: failure, reply }),
      SETTLED: Schema.Struct({
        identity: Schema.String,
        cause: Schema.UndefinedOr(failure),
        reply,
      }),
    },
  },
  actions: {
    respond: ({ params }: { params?: unknown }) => {
      const value = Schema.decodeUnknownSync(response)(params)
      return Deferred.succeed(value.reply, value.answer)
    },
  },
}).createMachine({
  id: "model-catalog",
  initial: "unrestored",
  context: {
    saved: undefined,
    restored: false,
    closed: false,
    background: [],
    failure: undefined,
    cleanup: undefined,
  },
  on: {
    CLOSE: (args, enq) => {
      enq(args.actions.respond, {
        ...args,
        params: { reply: args.event.reply, answer: { kind: "ack" } },
      })
      return { target: ".closed", context: { ...args.context, closed: true } }
    },
    READ: (args, enq) => {
      const decision = readDecision(
        args.context,
        args.event.identity,
        args.event.now
      )
      enq(args.actions.respond, {
        ...args,
        params: { reply: args.event.reply, answer: decision.answer },
      })
      return {
        target: `.${decision.phase}`,
        context: {
          ...args.context,
          background:
            decision.answer.kind === "value" && decision.answer.background
              ? [...args.context.background, decision.answer.background]
              : args.context.background,
        },
      }
    },
    RESTORE: (args, enq) => {
      enq(args.actions.respond, {
        ...args,
        params: { reply: args.event.reply, answer: { kind: "ack" } },
      })
      return {
        context: args.context.restored
          ? args.context
          : { ...args.context, saved: args.event.saved, restored: true },
      }
    },
    OUTCOME: (args, enq) => {
      enq(args.actions.respond, {
        ...args,
        params: {
          reply: args.event.reply,
          answer: publication(
            args.context.saved,
            args.event.identity,
            args.event.now,
            args.event.outcome
          ),
        },
      })
    },
    COMMIT: (args, enq) => {
      enq(args.actions.respond, {
        ...args,
        params: { reply: args.event.reply, answer: { kind: "ack" } },
      })
      return {
        context: { ...args.context, saved: args.event.saved, restored: true },
      }
    },
    FAILED: (args, enq) => {
      enq(args.actions.respond, {
        ...args,
        params: { reply: args.event.reply, answer: { kind: "ack" } },
      })
      return {
        target: ".failed",
        context: { ...args.context, failure: args.event.cause },
      }
    },
    SETTLED: (args, enq) => {
      enq(args.actions.respond, {
        ...args,
        params: { reply: args.event.reply, answer: { kind: "ack" } },
      })
      const fatal =
        args.context.background.includes(args.event.identity) &&
        args.event.cause &&
        (Cause.hasDies(args.event.cause) ||
          (Cause.hasInterrupts(args.event.cause) &&
            !Cause.hasInterruptsOnly(args.event.cause)))
          ? args.event.cause
          : undefined
      return {
        ...(fatal ? { target: ".failed" } : {}),
        context: {
          ...args.context,
          background: args.context.background.filter(
            (identity) => identity !== args.event.identity
          ),
          failure: fatal ?? args.context.failure,
          cleanup: fatal
            ? Cause.fromReasons([
                ...(args.context.cleanup?.reasons ?? []),
                ...fatal.reasons,
              ])
            : args.context.cleanup,
        },
      }
    },
  },
  states: {
    closed: {},
    unrestored: {},
    forwarding: {},
    fresh: {},
    stale: {},
    cooldown: {},
    refreshing: {},
    failed: {},
  },
})
