import { preserveFatal } from "../shared/effect"
import { Effect, Schema } from "effect"
import { CodeInput, type CodeOutput } from "../execution/contracts"
import type { WebAppRepository } from "./repository"
import {
  AppConflict,
  WebResult,
  type AppBlock,
  type InteractApp,
  type RenderWebApp,
} from "./contracts"
import { appHtml } from "./html"

export type WebExecutor = (
  input: CodeInput,
  signal: AbortSignal
) => Effect.Effect<CodeOutput, AppConflict>
export class WebApps {
  private running = false
  private generation = 0
  private controller: AbortController | null = null
  invalidate() {
    this.generation++
    this.controller?.abort()
  }
  constructor(
    private readonly store: WebAppRepository,
    private readonly execute: WebExecutor
  ) {}
  private run(
    block: Extract<AppBlock, { type: "web" }>,
    state: string,
    action: InteractApp["action"] | null,
    signal: AbortSignal
  ) {
    return Effect.yieldNow.pipe(
      Effect.andThen(
        Effect.acquireUseRelease(
          Effect.gen({ self: this }, function* () {
            if (signal.aborted) return yield* Effect.interrupt
            if (this.running)
              return yield* new AppConflict({
                message: "This bot is rendering another app. Retry shortly.",
              })
            const controller = new AbortController()
            const cancellation = AbortSignal.any([signal, controller.signal])
            this.running = true
            this.controller = controller
            return {
              generation: this.generation,
              controller,
              signal: cancellation,
            }
          }),
          (lease) =>
            Effect.gen({ self: this }, function* () {
              // Stored state was decoded by the owning repository. Corruption is a defect.
              const data = JSON.stringify({
                mode: action ? "action" : "render",
                state: JSON.parse(state),
                action,
              })
              const input = yield* Schema.decodeUnknownEffect(CodeInput)({
                code: block.code,
                data,
              }).pipe(preserveFatal, Effect.mapError(renderRejected))
              const result = yield* this.execute(input, lease.signal)
              yield* this.current(lease.generation, signal)
              if (result.error)
                return yield* new AppConflict({
                  message: `App code failed: ${result.error}`,
                })
              return yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(WebResult)
              )(result.result).pipe(
                preserveFatal,
                Effect.mapError(renderRejected)
              )
            }),
          (lease) =>
            Effect.sync(() => {
              lease.controller.abort()
              this.running = false
              this.controller = null
            })
        )
      ),
      Effect.withSpan("Apps.execute")
    )
  }
  private current(generation: number, signal: AbortSignal) {
    return Effect.gen({ self: this }, function* () {
      if (signal.aborted) return yield* Effect.interrupt
      if (generation !== this.generation)
        return yield* new AppConflict({
          message: "This app action was cancelled when its bot was archived.",
        })
    })
  }

  render(input: typeof RenderWebApp.Type, signal: AbortSignal) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.yieldNow
      if (signal.aborted) return yield* Effect.interrupt
      const generation = this.generation
      const app = (yield* this.store.detail(input.id)).app
      const version = yield* this.store.version(input.id, input.version)
      const block = version.definition.blocks[0]
      if (block?.type !== "web")
        return yield* new AppConflict({
          message: "This version is not a web app.",
        })
      const result = yield* this.run(
        block,
        app.publishedVersion === input.version
          ? (app.state.web?.[block.id] ?? block.initialState)
          : block.initialState,
        null,
        signal
      )
      const html = yield* markup(result.html)
      yield* this.current(generation, signal)
      return {
        id: app.id,
        version: version.version,
        revision: app.revision,
        html,
        css: result.css,
      }
    }).pipe(
      Effect.withSpan("Apps.render", {
        attributes: { "app.id": input.id, "app.version": input.version },
      })
    )
  }
  interact(input: InteractApp, signal: AbortSignal) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.yieldNow
      if (signal.aborted) return yield* Effect.interrupt
      const generation = this.generation
      const replay = yield* this.store.interactionReceipt(input)
      if (replay) return replay
      const app = yield* this.store.interactionSnapshot(input)
      const block = (yield* this.store.version(
        input.id,
        input.version
      )).definition.blocks.find((value) => value.id === input.action.blockId)
      if (block?.type !== "web" || input.action.type !== "web")
        return yield* new AppConflict({
          message: "This action is not available.",
        })
      const result = yield* this.run(
        block,
        app.state.web?.[block.id] ?? block.initialState,
        input.action,
        signal
      )
      yield* markup(result.html)
      yield* this.current(generation, signal)
      return yield* this.store.interact(input, result)
    }).pipe(
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
