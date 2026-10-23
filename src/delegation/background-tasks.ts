import { Clock, Context, Effect, Exit, Layer, Schema } from "effect"

import { preserveFatal } from "../shared/effect"
import { BackgroundHandoff } from "./background"
import { backgroundRejected } from "./background-domain"
import {
  backgroundChild,
  backgroundInitialId,
  projectBackgroundTasks,
  requireBackgroundState,
  type BackgroundState,
} from "./background-task-domain"
import type { BackgroundTaskLedger } from "./background-task-ledger"
import { makeBackgroundTaskOwner } from "./background-task-owner"
import {
  advanceBackgroundTask,
  initializeBackgroundTask,
} from "./background-task.machine"
import { Control, DelegationFailure } from "./contracts"

export interface BackgroundTaskAuthority {
  readonly authorized: (
    handoff: BackgroundHandoff
  ) => Effect.Effect<boolean, DelegationFailure>
}
export class BackgroundTasks extends Context.Service<
  BackgroundTasks,
  ReturnType<typeof makeBackgroundTasks>
>()("durable-pi/delegation/BackgroundTasks") {}
const decision = <T>(body: () => T) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const delegationFailure =
        Schema.decodeUnknownOption(DelegationFailure)(cause)
      if (delegationFailure._tag === "Some") return delegationFailure.value
      throw cause
    },
  })
const decode = <T>(schema: Schema.ConstraintDecoder<T>, raw: unknown) =>
  Schema.decodeUnknownEffect(schema)(raw).pipe(
    preserveFatal,
    Effect.mapError(() =>
      backgroundRejected("invalid", "Check the background task request fields.")
    )
  )

export function makeBackgroundTasks(
  ledger: BackgroundTaskLedger,
  authority: BackgroundTaskAuthority,
  now: Effect.Effect<number> = Clock.currentTimeMillis,
  owner = makeBackgroundTaskOwner()
) {
  const load = () =>
    ledger
      .state()
      .pipe(
        Effect.flatMap((state) => decision(() => requireBackgroundState(state)))
      )
  const edit = <T>(
    body: (
      state: BackgroundState,
      at: number
    ) => { state: BackgroundState; result: T }
  ) =>
    ledger.atomic((tx) =>
      Effect.gen(function* () {
        const document = yield* tx.state()
        const current = yield* decision(() =>
          requireBackgroundState(document.value)
        )
        const at = yield* now
        const change = yield* decision(() => body(current, at))
        if (change.state !== current) document.value = change.state
        return change.result
      })
    )
  const project = (state: BackgroundState) =>
    Effect.gen(function* () {
      const facts = yield* ledger.facts(state)
      return projectBackgroundTasks(state, facts, yield* now)
    })
  const own = owner.run
  const revoke = () =>
    edit((state) => ({
      state: advanceBackgroundTask(state, { type: "REVOKE" }),
      result: undefined,
    }))
  const cleanup = (child: number) =>
    own({
      claim: edit((state) => {
        const before = backgroundChild(state, child)
        if (before.stop === "none" || before.stop === "confirmed")
          return { state, result: undefined }
        const next = advanceBackgroundTask(state, { type: "STOP_CLAIM", child })
        return {
          state: next,
          result: {
            kind: "stop" as const,
            child,
            request: `background-stop:${child}`,
            claim: backgroundChild(next, child).stopAttempt,
            text: "",
            steer: false,
          },
        }
      }),
      dispatch: (command) => ledger.abort(command.child),
      record: (command, result) =>
        edit((state) => ({
          state: advanceBackgroundTask(state, {
            type: Exit.isSuccess(result) ? "STOP_ACK" : "STOP_FAILED",
            child: command.child,
            attempt: command.claim,
          }),
          result: undefined,
        })),
    })
  const dispatch = (request: string) =>
    own({
      claim: Effect.gen(function* () {
        const state = yield* load()
        const command = state.submissions.find(
          (value) => value.request === request
        )
        if (!command) return undefined
        if (
          command.steer &&
          !(yield* ledger.hasSubmission(
            command.child,
            backgroundInitialId(command.child)
          ))
        )
          return undefined
        const allowed =
          state.authority === "active" &&
          (yield* authority.authorized(state.handoff))
        return yield* edit((current, at) => {
          const revoked =
            current.outcome === "working" &&
            (!allowed || at >= current.handoff.deadline)
              ? advanceBackgroundTask(current, { type: "REVOKE" })
              : current
          const next = advanceBackgroundTask(revoked, {
            type: "CLAIM",
            request,
            now: at,
            authorized: allowed,
          })
          const claimed = next.submissions.find(
            (value) => value.request === request
          )!
          return {
            state: next,
            result:
              next !== revoked && claimed.status === "claimed"
                ? { ...claimed, kind: "submit" as const }
                : undefined,
          }
        })
      }),
      dispatch: (command) =>
        ledger.submit(
          command.child,
          command.text,
          command.request,
          command.steer
        ),
      record: (command, result) =>
        edit((state) => ({
          state: advanceBackgroundTask(state, {
            type: Exit.isSuccess(result) ? "SUBMITTED" : "UNCONFIRMED",
            request: command.request,
            claim: command.claim,
          }),
          result: undefined,
        })),
    })
  const stop = Effect.fn("BackgroundTasks.stop")(function* () {
    yield* revoke()
    for (const child of (yield* load()).children) yield* cleanup(child.id)
  })
  const drain = Effect.fn("BackgroundTasks.deliverControls")(function* (
    initial = false
  ) {
    for (const command of (yield* load()).submissions)
      if (initial || command.steer) yield* dispatch(command.request)
    for (const child of (yield* load()).children) yield* cleanup(child.id)
  })
  return {
    initialize: Effect.fn("BackgroundTasks.initialize")(function* (
      raw: unknown
    ) {
      const handoff = yield* decode(BackgroundHandoff, raw)
      if (handoff.input.tasks.some((task) => task.tools.length))
        return yield* backgroundRejected(
          "invalid",
          "Background tasks have no tool grants."
        )
      yield* ledger.atomic((tx) =>
        Effect.gen(function* () {
          const document = yield* tx.state()
          if (document.value) {
            if (
              JSON.stringify(document.value.handoff) !== JSON.stringify(handoff)
            )
              return yield* backgroundRejected(
                "conflict",
                "This group already has a different handoff."
              )
            return
          }
          const children = []
          for (const task of handoff.input.tasks)
            children.push(yield* tx.createChild(handoff, task))
          document.value = initializeBackgroundTask(handoff, children)
        })
      )
    }),
    advance: Effect.fn("BackgroundTasks.advance")(function* () {
      const state = yield* load()
      if (
        state.outcome === "working" &&
        (!(yield* authority.authorized(state.handoff)) ||
          (yield* now) >= state.handoff.deadline)
      )
        yield* revoke()
      yield* drain(true)
      const latest = yield* load(),
        view = yield* project(latest)
      yield* edit((current, at) => ({
        state: advanceBackgroundTask(current, {
          type: "OBSERVED",
          revision: latest.revision,
          settled: !view.children.some((child) =>
            ["queued", "working", "stopping"].includes(child.status)
          ),
          now: at,
        }),
        result: undefined,
      }))
      // Observation can cross the deadline after the first drain. Join the new
      // cleanup obligation before returning a cancellation acknowledgement.
      for (const child of (yield* load()).children) yield* cleanup(child.id)
      return yield* project(yield* load())
    }),
    read: Effect.fn("BackgroundTasks.read")(function* () {
      return yield* project(yield* load())
    }),
    stop,
    control: Effect.fn("BackgroundTasks.control")(function* (raw: unknown) {
      const input = yield* decode(Control, raw),
        state = yield* load()
      if (
        state.outcome === "working" &&
        !(yield* authority.authorized(state.handoff))
      )
        yield* stop()
      const accepted = yield* edit((current, at) => {
        const next = advanceBackgroundTask(current, {
          type: "CONTROL",
          input,
          now: at,
        })
        return { state: next, result: next !== current }
      })
      yield* drain()
      return { accepted }
    }),
    request: Effect.fn("BackgroundTasks.request")(function* (provider: string) {
      const state = yield* load()
      if (!(yield* authority.authorized(state.handoff)))
        return yield* backgroundRejected(
          "cancelled",
          "This background task has stopped."
        )
      yield* edit((current, at) => ({
        state: advanceBackgroundTask(current, {
          type: "REQUEST",
          provider,
          now: at,
        }),
        result: undefined,
      }))
    }),
    transcript: Effect.fn("BackgroundTasks.transcript")(function* (
      child: number,
      cursor?: string
    ) {
      const state = yield* load()
      yield* decision(() => backgroundChild(state, child))
      const before = cursor ? Number(cursor) : undefined
      if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
        return yield* backgroundRejected(
          "invalid",
          "Invalid transcript position."
        )
      return yield* ledger.transcript(child, before)
    }),
  }
}
export const backgroundTasksApplication = (
  ledger: BackgroundTaskLedger,
  authority: BackgroundTaskAuthority
) => Layer.sync(BackgroundTasks, () => makeBackgroundTasks(ledger, authority))
