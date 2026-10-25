import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Clock, Effect, Equal, Exit, Schema, Semaphore } from "effect"

import { CodeInput, type CodeOutput } from "../execution/contracts"
import { observeCleanup, preserveFatal } from "../shared/effect"
import {
  AppConflict,
  WebResult,
  WebPreview,
  AppDocument,
  type AppStorageError,
  type InteractApp,
  type RenderWebApp,
} from "./contracts"
import { appHtml } from "./html"
import { appRenderMachine, type AppRenderPrepared } from "./render.machine"
import type { WebAppRepository } from "./repository"

export type WebExecutor = (
  input: CodeInput,
  signal: AbortSignal
) => Effect.Effect<CodeOutput, AppConflict>
type Prepared = AppRenderPrepared
type WebError = AppConflict | AppStorageError
export class WebApps {
  private readonly lease = Semaphore.makeUnsafe(1)
  private readonly cancellations = new Set<AbortController>()
  invalidate() {
    for (const controller of this.cancellations)
      controller.abort(
        new AppConflict({
          message: "This app action was cancelled when its bot was archived.",
        })
      )
  }
  constructor(
    private readonly store: WebAppRepository,
    private readonly execute: WebExecutor,
    private readonly timeoutMs = 15_000
  ) {}
  private request(
    prepare: Effect.Effect<
      { prepared: Prepared } | { replay: AppDocument | WebPreview },
      WebError
    >,
    commit: (
      prepared: Prepared,
      result: WebResult
    ) => Effect.Effect<AppDocument | WebPreview, WebError>,
    signal: AbortSignal
  ) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.yieldNow
      if (signal.aborted) return yield* Effect.interrupt
      return yield* Effect.acquireUseRelease(
        Effect.gen({ self: this }, function* () {
          if (!(yield* this.lease.takeIfAvailable(1)))
            return yield* new AppConflict({
              message: "This bot is rendering another app. Retry shortly.",
            })
          const controller = new AbortController()
          this.cancellations.add(controller)
          return controller
        }),
        (controller) =>
          Effect.gen({ self: this }, function* () {
            const deadline = (yield* Clock.currentTimeMillis) + this.timeoutMs
            let failure: Cause.Cause<WebError> | undefined
            const bounded = <T>(work: Effect.Effect<T, WebError>) =>
              Effect.gen(function* () {
                const remaining = deadline - (yield* Clock.currentTimeMillis)
                if (remaining <= 0) return yield* renderRejected()
                return yield* observeCleanup(work, (observed) =>
                  Effect.raceFirst(
                    observed,
                    Effect.sleep(remaining).pipe(
                      Effect.andThen(
                        Effect.sync(() => controller.abort(renderRejected()))
                      ),
                      Effect.andThen(Effect.fail(renderRejected()))
                    )
                  )
                )
              }).pipe(
                Effect.onExit((exit) =>
                  Effect.sync(() => {
                    if (Exit.isFailure(exit)) failure = exit.cause
                  })
                )
              )
            return yield* Effect.gen({ self: this }, function* () {
              const actor = yield* createEffectActor(
                appRenderMachine({
                  prepare: bounded(prepare),
                  execute: (prepared: Prepared) =>
                    bounded(this.run(prepared, controller.signal)),
                  commit: (prepared: Prepared, result) =>
                    bounded(
                      Effect.suspend(() =>
                        controller.signal.aborted
                          ? Effect.interrupt
                          : commit(prepared, result)
                      )
                    ),
                })
              )
              const cancel = () =>
                actor.send({
                  type: "CANCEL",
                  outcome: Schema.is(AppConflict)(controller.signal.reason)
                    ? Exit.fail(controller.signal.reason)
                    : Exit.interrupt(),
                })
              const abort = () => controller.abort()
              signal.addEventListener("abort", abort, { once: true })
              controller.signal.addEventListener("abort", cancel, {
                once: true,
              })
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  signal.removeEventListener("abort", abort)
                  controller.signal.removeEventListener("abort", cancel)
                  controller.abort()
                })
              )
              if (signal.aborted) abort()
              if (controller.signal.aborted) cancel()
              const done = yield* waitFor(
                actor,
                (snapshot) => snapshot.status === "done"
              ).pipe(Effect.orDie)
              return yield* done.output!
            }).pipe(
              Effect.scoped,
              Effect.onExit((exit) => {
                if (!failure || !Cause.hasDies(failure)) return Effect.void
                const retained = Exit.isFailure(exit) ? exit.cause.reasons : []
                const missing = failure.reasons.filter(
                  (reason) =>
                    reason._tag !== "Interrupt" &&
                    !retained.some((present) => Equal.equals(present, reason))
                )
                return missing.length
                  ? Effect.failCause(Cause.fromReasons(missing))
                  : Effect.void
              })
            )
          }),
        (controller) =>
          Effect.sync(() => {
            this.cancellations.delete(controller)
            controller.abort()
          }).pipe(Effect.andThen(this.lease.release(1)))
      )
    }).pipe(Effect.withSpan("Apps.execute"))
  }
  private run(prepared: Prepared, signal: AbortSignal) {
    return Effect.gen({ self: this }, function* () {
      const data = JSON.stringify({
        mode: prepared.action ? "action" : "render",
        state: JSON.parse(prepared.state) as unknown,
        action: prepared.action,
      })
      const input = yield* Schema.decodeUnknownEffect(CodeInput)({
        code: prepared.block.code,
        data,
      }).pipe(preserveFatal, Effect.mapError(renderRejected))
      if (signal.aborted) return yield* Effect.interrupt
      const result = yield* this.execute(input, signal)
      if (signal.aborted) return yield* Effect.interrupt
      if (result.error)
        return yield* new AppConflict({
          message: `App code failed: ${result.error}`,
        })
      return yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(WebResult)
      )(result.result).pipe(preserveFatal, Effect.mapError(renderRejected))
    })
  }
  render(input: typeof RenderWebApp.Type, signal: AbortSignal) {
    return this.request(
      Effect.gen({ self: this }, function* () {
        const app = yield* this.store.renderSnapshot(input.id, input.version)
        const version = yield* this.store.version(input.id, input.version)
        const block = version.definition.blocks[0]
        if (block?.type !== "web")
          return yield* new AppConflict({
            message: "This version is not a web app.",
          })
        return {
          prepared: {
            app,
            block,
            state:
              app.publishedVersion === input.version
                ? (app.state.web?.[block.id] ?? block.initialState)
                : block.initialState,
            action: null,
          },
        }
      }),
      (prepared, result) =>
        Effect.gen({ self: this }, function* () {
          const html = yield* markup(result.html)
          const current = yield* this.store.renderSnapshot(
            input.id,
            input.version
          )
          if (current.revision !== prepared.app.revision)
            return yield* new AppConflict({
              message: "This app changed while rendering. Reload the preview.",
            })
          return {
            id: prepared.app.id,
            version: input.version,
            revision: prepared.app.revision,
            html,
            css: result.css,
          }
        }),
      signal
    ).pipe(
      Effect.map(Schema.decodeUnknownSync(WebPreview)),
      Effect.withSpan("Apps.render", {
        attributes: { "app.id": input.id, "app.version": input.version },
      })
    )
  }
  interact(
    input: InteractApp,
    signal: AbortSignal,
    discoveryDeadline?: number
  ) {
    return this.request(
      Effect.gen({ self: this }, function* () {
        const replay = yield* this.store.interactionReceipt(input)
        if (replay) return { replay }
        const app = yield* this.store.interactionSnapshot(input)
        const block = (yield* this.store.version(
          input.id,
          input.version
        )).definition.blocks.find((value) => value.id === input.action.blockId)
        if (block?.type !== "web" || input.action.type !== "web")
          return yield* new AppConflict({
            message: "This action is not available.",
          })
        return {
          prepared: {
            app,
            block,
            state: app.state.web?.[block.id] ?? block.initialState,
            action: input.action,
          },
        }
      }),
      (_, result) =>
        markup(result.html).pipe(
          Effect.andThen(this.store.interact(input, result, discoveryDeadline))
        ),
      signal
    ).pipe(
      Effect.map(Schema.decodeUnknownSync(AppDocument)),
      Effect.withSpan("Apps.interact", {
        attributes: {
          "app.id": input.id,
          "app.operation_id": input.operationId,
        },
      })
    )
  }
}

const renderRejected = () =>
  new AppConflict({
    message:
      "The app could not render within its limits. Its saved state is unchanged.",
  })
const markup = (html: string) =>
  Effect.try({
    try: () => appHtml(html),
    catch: (cause) => {
      const known = Schema.decodeUnknownOption(AppConflict)(cause)
      if (known._tag === "Some") return known.value
      throw cause
    },
  })
