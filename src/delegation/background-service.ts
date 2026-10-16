import { Context, Effect, Layer, Schema } from "effect"
import { preserveFatal } from "../shared/effect"
import { backgroundBrief } from "./background"
import {
  backgroundRejected,
  projectBackground,
  requireReportOwner,
  type BackgroundAuthority,
} from "./background-domain"
import type { ConversationFailure } from "../conversations/turns"
import type {
  BackgroundStorageError,
  BackgroundLedger,
} from "./background-ledger"
import {
  BackgroundMailbox,
  makeBackgroundMailbox,
  type BackgroundAdmission,
  type BackgroundError,
  type BackgroundMailboxService,
} from "./background-mailbox"
import {
  DelegationFailure,
  type Control,
  type Group,
  type Transcript,
} from "./contracts"
import type { DelegationSource } from "./delegation"

export interface BackgroundRemote {
  readonly start: (id: number) => Effect.Effect<Group, DelegationFailure>
  readonly read: (id: number) => Effect.Effect<Group, DelegationFailure>
  readonly stop: (id: number) => Effect.Effect<void, DelegationFailure>
  readonly control: (
    input: Control
  ) => Effect.Effect<{ accepted: boolean }, DelegationFailure>
  readonly transcript: (
    group: number,
    child: number,
    cursor?: string
  ) => Effect.Effect<Transcript, DelegationFailure>
}
export interface BackgroundHost {
  readonly active: () => Effect.Effect<boolean, BackgroundError>
  readonly backgroundActive: () => Effect.Effect<boolean, BackgroundError>
  readonly wakeConversation: () => Effect.Effect<void, DelegationFailure>
  readonly wakeBackground: () => Effect.Effect<void, DelegationFailure>
  readonly notify: () => Effect.Effect<void>
  readonly admission: BackgroundAdmission
}
export class BackgroundDelegation extends Context.Service<
  BackgroundDelegation,
  ReturnType<typeof makeBackgroundDelegation>
>()("durable-pi/delegation/Background") {}

const ignoreUnavailable = <T, TRequirements>(
  work: Effect.Effect<T, DelegationFailure, TRequirements>
) =>
  work.pipe(
    preserveFatal,
    Effect.catchTag("DelegationFailure", (error) =>
      error.code === "unavailable" ? Effect.void : Effect.fail(error)
    )
  )

export function makeBackgroundDelegation(
  mailbox: BackgroundMailboxService,
  remote: BackgroundRemote,
  host: BackgroundHost
) {
  const required = (id: number) =>
    mailbox
      .get(id)
      .pipe(
        Effect.flatMap((row) =>
          row
            ? Effect.succeed(row)
            : Effect.fail(
                backgroundRejected(
                  "not_found",
                  "Background group unavailable in this bot."
                )
              )
        )
      )
  const read = Effect.fn("Background.read")(function* (id: number) {
    const row = yield* required(id)
    // A handoff may be accepted, paused or stopped before native initialization.
    // Acknowledged running/finished groups must still surface missing records.
    const group = yield* remote.read(id).pipe(
      preserveFatal,
      Effect.catchTag("DelegationFailure", (error) =>
        error.code === "unavailable" ||
        (error.code === "not_found" &&
          ["pending", "paused", "cancelled"].includes(row.status))
          ? Effect.succeed(undefined)
          : Effect.fail(error)
      )
    )
    if (group)
      yield* Effect.try({
        try: () => requireReportOwner(row, group),
        catch: (cause) => {
          const delegationFailure =
            Schema.decodeUnknownOption(DelegationFailure)(cause)
          if (delegationFailure._tag === "Some") return delegationFailure.value
          throw cause
        },
      })
    // Re-read after the RPC so a concurrent Stop is visible in the projection.
    return projectBackground(yield* required(id), group)
  })
  return {
    read,
    list: Effect.fn("Background.list")(function* (offset = 0) {
      const rows = yield* mailbox.list(offset)
      return yield* Effect.forEach(rows, (row) => read(row.id), {
        concurrency: 2,
      })
    }),
    handoff: Effect.fn("Background.handoff")(function* (id: number) {
      return (yield* required(id)).handoff
    }),
    authorized: mailbox.authorized,
    create: Effect.fn("Background.create")(function* (
      input: unknown,
      source: DelegationSource
    ) {
      // Let an already cancelled caller attach its signal before a durable write.
      yield* Effect.yieldNow
      const brief = yield* Effect.try({
        try: () => backgroundBrief(input),
        catch: () =>
          backgroundRejected("invalid", "Invalid background task brief."),
      })
      const row = yield* mailbox.create(brief, source)
      yield* host.wakeBackground()
      return `Background group ${row.id} accepted. Its text-only drafting children have no tools. You can finish this reply; the findings will arrive later in this bot's chat. Do not claim the work is complete. Activity has progress and Stop controls.`
    }),
    stop: Effect.fn("Background.stop")(function* (id: number) {
      yield* Effect.yieldNow
      yield* mailbox.cancel(id, host.admission)
      yield* ignoreUnavailable(remote.stop(id))
      yield* host.wakeConversation()
      return { accepted: true }
    }),
    retry: Effect.fn("Background.retry")(function* (
      id: number,
      operationId: string
    ) {
      yield* Effect.yieldNow
      const accepted = yield* mailbox.retry(id, operationId)
      yield* host.wakeBackground()
      return { accepted }
    }),
    control: Effect.fn("Background.control")(function* (input: Control) {
      yield* Effect.yieldNow
      yield* required(input.groupId)
      const result = yield* remote.control(input)
      yield* host.wakeBackground()
      return result
    }),
    transcript: Effect.fn("Background.transcript")(function* (
      group: number,
      child: number,
      cursor?: string
    ) {
      yield* required(group)
      return yield* remote.transcript(group, child, cursor)
    }),
    step: Effect.fn("Background.reconcile")(function* () {
      yield* Effect.yieldNow
      for (const row of yield* mailbox.reconcileCancellation())
        yield* ignoreUnavailable(remote.stop(row.id))
      for (const row of yield* mailbox.due()) {
        // Only a remote outage consumes the transport retry budget. Storage,
        // ownership, defects and cancellation must not become retries.
        const group = yield* remote.start(row.id).pipe(
          preserveFatal,
          Effect.catchTag(
            "DelegationFailure",
            (
              error
            ): Effect.Effect<
              Group | undefined,
              DelegationFailure | BackgroundStorageError | ConversationFailure
            > =>
              error.code === "unavailable"
                ? mailbox.failed(row.id).pipe(Effect.as(undefined))
                : Effect.fail(error)
          )
        )
        if (group) yield* mailbox.observed(row.id, group)
      }
      if (!(yield* host.active()) && (yield* mailbox.deliver(host.admission))) {
        yield* host.wakeConversation()
        yield* host.notify()
      }
      if (yield* host.backgroundActive()) yield* host.wakeConversation()
      return yield* mailbox.nextWake()
    }),
  }
}

export const backgroundApplication = (
  records: BackgroundLedger,
  authority: (
    turnId: string
  ) => Effect.Effect<BackgroundAuthority, ConversationFailure>,
  parentObject: string,
  uuid: () => string,
  remote: BackgroundRemote,
  host: BackgroundHost
) =>
  Layer.syncContext(() => {
    const mailbox = makeBackgroundMailbox(
      records,
      authority,
      parentObject,
      uuid
    )
    return Context.make(BackgroundMailbox, mailbox).pipe(
      Context.add(
        BackgroundDelegation,
        makeBackgroundDelegation(mailbox, remote, host)
      )
    )
  })
