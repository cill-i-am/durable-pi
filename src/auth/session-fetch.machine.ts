import { setupEffect } from "@xstate/effect"
import { Deferred, Effect, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

export type SessionFetchOutcome =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly error: unknown }
export interface SessionFetchRequest {
  readonly id: number
  readonly key: string
  readonly input: Parameters<typeof fetch>[0]
  readonly init: RequestInit | undefined
  readonly signal: AbortSignal | null | undefined
  readonly reply: Deferred.Deferred<SessionFetchOutcome>
}
interface Read {
  readonly request: SessionFetchRequest
  readonly subscribers: readonly SessionFetchRequest[]
}
interface Admission {
  readonly reads: readonly Read[]
  readonly waiting: readonly SessionFetchRequest[]
  readonly mutations: readonly SessionFetchRequest[]
  readonly active: SessionFetchRequest | null
  readonly limitedUntil: number
}
const request = Schema.Struct({
  id: Schema.Number,
  key: Schema.String,
  input: Schema.Union([
    Schema.String,
    Schema.instanceOf(Request),
    Schema.instanceOf(URL),
  ]),
  init: Schema.declare(
    (value): value is RequestInit | undefined =>
      value === undefined ||
      (typeof value === "object" && value !== null && !Array.isArray(value))
  ),
  signal: Schema.NullishOr(Schema.instanceOf(AbortSignal)),
  reply: Schema.declare(
    (value): value is Deferred.Deferred<SessionFetchOutcome> =>
      Deferred.isDeferred(value)
  ),
})
const outcome = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    response: Schema.instanceOf(Response),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.Unknown }),
])
const ack = Schema.declare((value): value is Deferred.Deferred<void> =>
  Deferred.isDeferred(value)
)
export const sessionFetchClosed = () =>
  new DOMException("Session request owner closed", "AbortError")

/** The actor alone decides which native requests may run. Deferreds and native
 * inputs are handles; they are not another admission or cooldown authority. */
export const sessionFetchMachine = (host: {
  now: () => number
  launch: (
    request: SessionFetchRequest,
    mutation: boolean
  ) => Effect.Effect<void>
}) => {
  type Launch = (request: SessionFetchRequest, mutation: boolean) => void
  type Reply = (
    request: SessionFetchRequest,
    result: SessionFetchOutcome
  ) => void
  const read = (
    state: Admission,
    job: SessionFetchRequest,
    launch: Launch,
    reply: Reply
  ): Admission => {
    if (job.signal?.aborted) {
      reply(job, { ok: false, error: job.signal.reason })
      return state
    }
    const now = host.now()
    if (state.limitedUntil > now) {
      reply(job, {
        ok: true,
        response: Response.json(
          {
            code: "TOO_MANY_REQUESTS",
            message: "Please wait before checking your session again.",
          },
          {
            status: 429,
            headers: {
              "Retry-After": String(
                Math.ceil((state.limitedUntil - now) / 1000)
              ),
            },
          }
        ),
      })
      return state
    }
    const existing = state.reads.find((item) => item.request.key === job.key)
    if (existing)
      return {
        ...state,
        reads: state.reads.map((item) =>
          item === existing
            ? { ...item, subscribers: [...item.subscribers, job] }
            : item
        ),
      }
    launch(job, false)
    return {
      ...state,
      reads: [...state.reads, { request: job, subscribers: [job] }],
    }
  }
  const drain = (state: Admission, launch: Launch, reply: Reply): Admission => {
    if (state.active || state.reads.length) return state
    const [first, ...rest] = state.mutations
    if (first) {
      launch(first, true)
      return { ...state, active: first, mutations: rest }
    }
    return state.waiting.reduce(
      (current, job) => read(current, job, launch, reply),
      { ...state, waiting: [] } as Admission
    )
  }
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.declare(
        (value): value is Admission =>
          typeof value === "object" && value !== null && "limitedUntil" in value
      ),
      events: {
        READ: Schema.Struct({ request }),
        MUTATE: Schema.Struct({ request }),
        SETTLED: Schema.Struct({
          id: Schema.Number,
          mutation: Schema.Boolean,
          outcome,
          limitedUntil: Schema.NullOr(Schema.Number),
          ack,
        }),
        CLOSE: Schema.Struct({ ack }),
      },
    },
    actions: {
      launch: ({ params }: { params?: unknown }) => {
        const input = Schema.decodeUnknownSync(
          Schema.Struct({ request, mutation: Schema.Boolean })
        )(params)
        return host.launch(input.request, input.mutation)
      },
      reply: ({ params }: { params?: unknown }) => {
        const input = Schema.decodeUnknownSync(
          Schema.Struct({ request, outcome })
        )(params)
        return Deferred.succeed(input.request.reply, input.outcome)
      },
      acknowledge: ({ params }: { params?: unknown }) =>
        Deferred.succeed(Schema.decodeUnknownSync(ack)(params), undefined),
    },
  }).createMachine({
    id: "auth-session-fetch",
    initial: "open",
    context: {
      reads: [],
      waiting: [],
      mutations: [],
      active: null,
      limitedUntil: 0,
    },
    on: {
      SETTLED: (args, enq) => {
        const { event, context } = args
        const launch: Launch = (request, mutation) =>
          enq(args.actions.launch, { ...args, params: { request, mutation } })
        const reply: Reply = (request, outcome) =>
          enq(args.actions.reply, { ...args, params: { request, outcome } })
        let next = context
        if (event.mutation && context.active?.id === event.id) {
          reply(context.active, event.outcome)
          next = {
            ...context,
            active: null,
            limitedUntil: event.outcome.ok ? 0 : context.limitedUntil,
          }
        } else if (!event.mutation) {
          const item = context.reads.find(
            (read) => read.request.id === event.id
          )
          if (item) {
            for (const job of item.subscribers) reply(job, event.outcome)
            next = {
              ...context,
              reads: context.reads.filter((read) => read !== item),
              limitedUntil: event.limitedUntil ?? context.limitedUntil,
            }
          }
        }
        enq(args.actions.acknowledge, { ...args, params: event.ack })
        return {
          context: args.value === "open" ? drain(next, launch, reply) : next,
        }
      },
    },
    states: {
      open: {
        on: {
          READ: (args, enq) => {
            const launch: Launch = (request, mutation) =>
              enq(args.actions.launch, {
                ...args,
                params: { request, mutation },
              })
            const reply: Reply = (request, outcome) =>
              enq(args.actions.reply, { ...args, params: { request, outcome } })
            return {
              context:
                args.context.active || args.context.mutations.length
                  ? {
                      ...args.context,
                      waiting: [...args.context.waiting, args.event.request],
                    }
                  : read(args.context, args.event.request, launch, reply),
            }
          },
          MUTATE: (args, enq) => ({
            context: drain(
              {
                ...args.context,
                mutations: [...args.context.mutations, args.event.request],
              },
              (request, mutation) =>
                enq(args.actions.launch, {
                  ...args,
                  params: { request, mutation },
                }),
              (request, outcome) =>
                enq(args.actions.reply, {
                  ...args,
                  params: { request, outcome },
                })
            ),
          }),
          CLOSE: (args, enq) => {
            for (const request of [
              ...args.context.waiting,
              ...args.context.mutations,
            ])
              enq(args.actions.reply, {
                ...args,
                params: {
                  request,
                  outcome: { ok: false, error: sessionFetchClosed() },
                },
              })
            enq(args.actions.acknowledge, { ...args, params: args.event.ack })
            return {
              target: "closed",
              context: { ...args.context, waiting: [], mutations: [] },
            }
          },
        },
      },
      closed: {
        on: {
          READ: (args, enq) =>
            enq(args.actions.reply, {
              ...args,
              params: {
                request: args.event.request,
                outcome: { ok: false, error: sessionFetchClosed() },
              },
            }),
          MUTATE: (args, enq) =>
            enq(args.actions.reply, {
              ...args,
              params: {
                request: args.event.request,
                outcome: { ok: false, error: sessionFetchClosed() },
              },
            }),
          CLOSE: (args, enq) =>
            enq(args.actions.acknowledge, { ...args, params: args.event.ack }),
        },
      },
    },
  })
}
