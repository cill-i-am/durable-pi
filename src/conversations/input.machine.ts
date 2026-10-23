import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { AttachmentContent, FileInfo } from "../workspace/files"
import { TurnRecord, type PreparedMessage, type Turn } from "./turns"

const Context = Schema.Struct({
  status: TurnRecord.fields.status,
  prompt: Schema.NullOr(Schema.String),
  session_id: Schema.NullOr(Schema.String),
  files_pending: Schema.Boolean,
  attachments: Schema.Array(FileInfo),
  input: Schema.Array(AttachmentContent),
  skill_context: Schema.String,
})
type Context = typeof Context.Type
const events = {
  PREPARE_ATTACHMENTS: Schema.Struct({
    prepared: Schema.Struct({
      pending: Schema.optional(Schema.Boolean),
      error: Schema.optional(Schema.String),
      files: Schema.Array(FileInfo),
      content: Schema.Array(AttachmentContent),
    }),
  }),
  PIN_PROMPT: Schema.Struct({ prompt: Schema.String }),
  PIN_SESSION: Schema.Struct({ session: Schema.String }),
  SUBMITTED: Schema.Struct({ session: Schema.String }),
  CONSUMED: Schema.Struct({}),
  FINISH: Schema.Struct({
    delivery: Schema.Literals(["answered", "unanswered"]),
  }),
}
const pending = (context: Context) =>
  ["queued", "preparing", "running", "stopping"].includes(context.status)
const submittable = (context: Context) =>
  !context.files_pending &&
  ["queued", "preparing", "running"].includes(context.status)
const submitted = ({
  context,
  event,
}: {
  context: Context
  event: { session: string }
}) => {
  if (
    !submittable(context) ||
    (context.session_id !== null && context.session_id !== event.session)
  )
    return
  return {
    context:
      context.session_id === null
        ? { ...context, session_id: event.session }
        : context,
  }
}
const active = {
  PREPARE_ATTACHMENTS: ({
    context,
    event,
  }: {
    context: Context
    event: { prepared: PreparedMessage }
  }) => {
    if (
      !context.files_pending ||
      !["queued", "preparing"].includes(context.status) ||
      context.prompt !== null
    )
      return
    if (
      JSON.stringify(context.attachments.map((file) => file.id)) !==
      JSON.stringify(event.prepared.files.map((file) => file.id))
    )
      throw new Error("Prepared attachments do not match the admitted request")
    return {
      context: {
        ...context,
        files_pending: event.prepared.pending ?? false,
        attachments: event.prepared.files,
        input: event.prepared.content,
      },
    }
  },
  PIN_PROMPT: ({
    context,
    event,
  }: {
    context: Context
    event: { prompt: string }
  }) =>
    submittable(context) && context.prompt === null
      ? {
          context: {
            ...context,
            prompt: event.prompt,
            input: [],
            skill_context: "",
          },
        }
      : undefined,
  PIN_SESSION: ({
    context,
    event,
  }: {
    context: Context
    event: { session: string }
  }) =>
    pending(context) && context.session_id === null
      ? { context: { ...context, session_id: event.session } }
      : undefined,
  FINISH: ({
    context,
    event,
  }: {
    context: Context
    event: { delivery: "answered" | "unanswered" }
  }) =>
    pending(context)
      ? {
          target: event.delivery,
          context: {
            ...context,
            files_pending: false,
            input: [],
            prompt: null,
            skill_context: "",
          },
        }
      : undefined,
}

/** Input data and native delivery receipts have one owner, independently of the
 * root run's status. Root ownership is checked by the enclosing transaction. */
export const conversationInputMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: { input: Context, context: Context, events },
}).createMachine({
  id: "conversation-input",
  version: "1",
  initial: "queued",
  context: ({ input }) => input,
  states: {
    queued: {
      on: {
        ...active,
        SUBMITTED: (args) => {
          const next = submitted(args)
          return next ? { ...next, target: "accepted" } : undefined
        },
        CONSUMED: ({ context }) =>
          pending(context) ? { target: "consumed" } : undefined,
      },
    },
    accepted: {
      on: {
        ...active,
        SUBMITTED: submitted,
        CONSUMED: ({ context }) =>
          pending(context) ? { target: "consumed" } : undefined,
      },
    },
    consumed: { on: { ...active, SUBMITTED: submitted } },
    answered: {},
    unanswered: {},
  },
})
export type ConversationInputEvent = EventFromLogic<
  typeof conversationInputMachine
>

function restored(turn: Turn) {
  const context = Schema.decodeUnknownSync(Context)({
    status: turn.status,
    prompt: turn.prompt,
    session_id: turn.session_id,
    files_pending: turn.files_pending ?? false,
    attachments: turn.attachments,
    input: turn.input,
    skill_context: turn.skill_context ?? "",
  })
  return conversationInputMachine.resolveState({
    value: Schema.decodeUnknownSync(TurnRecord.fields.delivery)(turn.delivery),
    context,
  })
}
function validateEvent(
  event: unknown
): asserts event is ConversationInputEvent {
  if (
    typeof event !== "object" ||
    event === null ||
    !("type" in event) ||
    typeof event.type !== "string" ||
    !Object.hasOwn(events, event.type)
  )
    throw new Error("Invalid conversation input event")
  const { type, ...payload } = event
  const schema = events[type as keyof typeof events]
  if (Object.keys(payload).some((key) => !Object.hasOwn(schema.fields, key)))
    throw new Error("Unsupported conversation input event field")
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(payload)
}

export function advanceInput(
  turn: Turn,
  event: ConversationInputEvent
): Turn | undefined {
  validateEvent(event)
  const current = restored(turn)
  const [next, effects] = transition(conversationInputMachine, current, event)
  if (effects.length)
    throw new Error(
      `Unsupported conversation input effect: ${effects[0]!.type}`
    )
  if (
    next.value === current.value &&
    JSON.stringify(next.context) === JSON.stringify(current.context)
  )
    return event.type === "PREPARE_ATTACHMENTS" && current.can(event)
      ? turn
      : undefined
  return {
    ...turn,
    ...Schema.decodeUnknownSync(Context)(next.context),
    delivery: Schema.decodeUnknownSync(TurnRecord.fields.delivery)(next.value),
  }
}

/** Query the same transition that records the native submission receipt. */
export function canSubmitInput(turn: Turn): boolean {
  return restored(turn).can({
    type: "SUBMITTED",
    session: turn.session_id ?? "unbound",
  })
}
