import { Clock, Effect, Random } from "effect"
import { Mailbox, MailboxTransport } from "./mailbox"
import { failure, type Envelope, type CommunicationError } from "./contracts"

export const receive = Effect.fn("communication.receive")(function* (
  envelope: Envelope,
  arm: Effect.Effect<void, CommunicationError> = Effect.void
) {
  const transport = yield* MailboxTransport
  yield* transport.authenticate(envelope)
  const mailbox = yield* Mailbox
  yield* arm
  return yield* mailbox.accept(envelope, yield* Clock.currentTimeMillis)
})

export const deliverNext = Effect.fn("communication.deliver")(function* () {
  const mailbox = yield* Mailbox,
    transport = yield* MailboxTransport
  yield* mailbox.expire(yield* Clock.currentTimeMillis)
  const d = yield* mailbox.claimDelivery(yield* Clock.currentTimeMillis)
  if (!d) return false
  const result = yield* transport.deliver(d.envelope).pipe(
    Effect.timeout("10 seconds"),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(failure("transport", "Delivery acknowledgement timed out."))
    ),
    Effect.result
  )
  if (result._tag === "Success") {
    yield* mailbox.delivered(d.envelope.id, d.attempts, result.success)
  } else {
    const jitter = yield* Random.next
    const delay = Math.round(
      Math.min(60000, 1000 * 2 ** (d.attempts - 1)) * (0.75 + jitter / 2)
    )
    yield* mailbox.deliveryFailed(
      d.envelope.id,
      d.attempts,
      yield* Clock.currentTimeMillis,
      delay,
      ["invalid", "forbidden", "conflict", "expired"].includes(
        result.failure.code
      )
    )
  }
  return true
})
