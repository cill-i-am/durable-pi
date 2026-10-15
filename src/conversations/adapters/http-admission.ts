import { preserveFatal } from "../../shared/effect"
import { Effect, Schema } from "effect"
import { ConversationRejected, type SubmissionReceipt } from "../admission"
import type { ConversationNotFound } from "../commands"

export const admissionResponse = <TError, TRequirements>(
  operation: Effect.Effect<
    SubmissionReceipt,
    TError | ConversationRejected | ConversationNotFound,
    TRequirements
  >
) =>
  operation.pipe(
    Effect.map((receipt) => Response.json(receipt, { status: 202 })),
    preserveFatal,
    Effect.catchTag("ConversationRejected", (cause) =>
      Effect.sync(() => {
        const rejected = Schema.decodeUnknownSync(ConversationRejected)(cause)
        const responses = {
          empty: [400, "Write a message first."],
          disconnected: [503, "Connect ChatGPT before sending a message."],
          archived: [409, "Restore this agent before sending a message."],
        } as const
        const [status, error] = responses[rejected.reason]
        return Response.json({ error }, { status })
      })
    ),
    preserveFatal,
    Effect.catchTag("ConversationNotFound", () =>
      Effect.succeed(
        Response.json({ error: "Reply not found." }, { status: 404 })
      )
    )
  )
