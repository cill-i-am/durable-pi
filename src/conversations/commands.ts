import { Effect, Schema } from "effect"
import type { Conversations } from "./service"
import type { Submission } from "./turns"
import type { SubmissionReceipt } from "./admission"

export class ConversationNotFound extends Schema.TaggedError<ConversationNotFound>()(
  "ConversationNotFound",
  {}
) {}

export const retryMessage = <TError, TRequirements>(
  conversations: Pick<typeof Conversations.Service, "get">,
  admit: (
    input: Submission
  ) => Effect.Effect<SubmissionReceipt, TError, TRequirements>
) =>
  Effect.fn("Conversations.retryMessage")(function* (input: {
    operationId: string
    turnId: string
  }) {
    const source = yield* conversations.get(input.turnId)
    if (!source) return yield* new ConversationNotFound()
    return yield* admit({
      operationId: input.operationId,
      text: source.text,
      files: source.attachments.map((file) => file.id),
      retryOf: source.id,
    })
  })

export const stopConversation = <TError, TRequirements>(
  conversations: Pick<typeof Conversations.Service, "requestStop">,
  host: {
    wake: () => Effect.Effect<void, TError, TRequirements>
    wakeBackground: () => Effect.Effect<void, TError, TRequirements>
    notify: () => Effect.Effect<void, TError, TRequirements>
  }
) =>
  Effect.fn("Conversations.stop")((id: string) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        // Save the intent before its doorbells. Exact retry repairs a lost wake
        // acknowledgment without reverting or dispatching a stopped turn.
        yield* conversations.requestStop(id)
        yield* host.wake()
        yield* host.wakeBackground()
        yield* host.notify()
      })
    )
  )
