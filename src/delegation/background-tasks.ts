import { Clock, Context, Effect, Layer, Schema } from "effect"

import { preserveFatal } from "../shared/effect"
import { BackgroundHandoff } from "./background"
import { backgroundRejected } from "./background-domain"
import {
  acceptBackgroundControl,
  backgroundChild,
  backgroundControlId,
  backgroundInitialId,
  consumeBackgroundRequest,
  projectBackgroundTasks,
  requireBackgroundState,
  stopBackgroundState,
  type BackgroundState,
} from "./background-task-domain"
import type { BackgroundTaskLedger } from "./background-task-ledger"
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
  now: Effect.Effect<number> = Clock.currentTimeMillis
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
  const stop = Effect.fn("BackgroundTasks.stop")(function* () {
    const children = yield* edit((state) => ({
      state: stopBackgroundState(state),
      result: state.sealed ? [] : state.children,
    }))
    yield* Effect.forEach(children, (child) => ledger.abort(child.id), {
      concurrency: 3,
      discard: true,
    })
  })
  const drain = Effect.fn("BackgroundTasks.deliverControls")(function* () {
    const state = yield* load()
    for (const input of state.controls) {
      const latest = yield* load()
      if (latest.applied.includes(input.operationId)) continue
      const child = yield* decision(() =>
        backgroundChild(latest, input.childId)
      )
      if (
        input.action.type === "stop" ||
        latest.stopped ||
        child.stopped ||
        (yield* now) >= latest.handoff.deadline
      )
        yield* ledger.abort(child.id)
      else if (!latest.sealed) {
        if (
          !(yield* ledger.hasSubmission(
            child.id,
            backgroundInitialId(child.id)
          ))
        )
          continue
        yield* ledger.submit(
          child.id,
          input.action.text,
          backgroundControlId(input),
          true
        )
      }
      yield* edit((current) => ({
        state: {
          ...current,
          applied: [...new Set([...current.applied, input.operationId])],
        },
        result: undefined,
      }))
    }
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
            children.push({
              ...(yield* tx.createChild(handoff, task)),
              requests: 0,
              stopped: false,
            })
          document.value = {
            handoff,
            children,
            stopped: false,
            sealed: false,
            revision: 0,
            controls: [],
            applied: [],
          }
        })
      )
    }),
    advance: Effect.fn("BackgroundTasks.advance")(function* () {
      const state = yield* load()
      if (!state.sealed && !(yield* authority.authorized(state.handoff)))
        yield* edit((current) => ({
          state: stopBackgroundState(current),
          result: undefined,
        }))
      yield* edit((current, at) => ({
        state:
          !current.sealed && !current.stopped && at >= current.handoff.deadline
            ? stopBackgroundState(current)
            : current,
        result: undefined,
      }))
      for (const [index, child] of state.children.entries()) {
        const latest = yield* load()
        if (latest.sealed) break
        if (
          latest.stopped ||
          latest.children[index]!.stopped ||
          (yield* now) >= latest.handoff.deadline
        )
          yield* ledger.abort(child.id)
        else
          yield* ledger.submit(
            child.id,
            latest.handoff.input.tasks[index]!.task,
            backgroundInitialId(child.id),
            false
          )
      }
      yield* drain()
      const latest = yield* load(),
        view = yield* project(latest)
      if (
        !view.children.some((child) =>
          ["queued", "working", "stopping"].includes(child.status)
        )
      )
        yield* edit((current, at) => ({
          state:
            !current.sealed && current.revision === latest.revision
              ? {
                  ...current,
                  sealed: true,
                  stopped: current.stopped || at >= current.handoff.deadline,
                }
              : current,
          result: undefined,
        }))
      return yield* project(yield* load())
    }),
    read: Effect.fn("BackgroundTasks.read")(function* () {
      return yield* project(yield* load())
    }),
    stop,
    control: Effect.fn("BackgroundTasks.control")(function* (raw: unknown) {
      const input = yield* decode(Control, raw),
        state = yield* load()
      if (!state.sealed && !(yield* authority.authorized(state.handoff)))
        yield* stop()
      const accepted = yield* edit((current, at) => {
        const next = acceptBackgroundControl(current, input, at)
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
        state: consumeBackgroundRequest(current, provider, at),
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
