import { Effect, Schema } from "effect"
import { CodeInput, type CodeOutput } from "../execution/contracts"
import type { AppStore } from "./adapters/sqlite"
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
) => Promise<CodeOutput>
/** App state owns the commit. Pure rendering executes in the existing isolated Worker. */
export class WebApps {
  private running = false
  private generation = 0
  private controller: AbortController | null = null
  invalidate() {
    this.generation++
    this.controller?.abort()
  }
  constructor(
    private readonly store: AppStore,
    private readonly execute: WebExecutor
  ) {}
  private run(
    block: Extract<AppBlock, { type: "web" }>,
    state: string,
    action: InteractApp["action"] | null,
    signal: AbortSignal
  ) {
    return Effect.tryPromise({
      try: async () => {
        if (this.running)
          throw new AppConflict({
            message: "This bot is rendering another app. Retry shortly.",
          })
        signal.throwIfAborted()
        this.running = true
        const generation = this.generation
        const controller = new AbortController()
        this.controller = controller
        const executionSignal = AbortSignal.any([signal, controller.signal])
        try {
          const input = Schema.decodeUnknownSync(CodeInput)({
            code: block.code,
            data: JSON.stringify({
              mode: action ? "action" : "render",
              state: JSON.parse(state),
              action,
            }),
          })
          const result = await this.execute(input, executionSignal)
          executionSignal.throwIfAborted()
          if (generation !== this.generation)
            throw new AppConflict({
              message:
                "This app action was cancelled when its bot was archived.",
            })
          if (result.error)
            throw new AppConflict({
              message: `App code failed: ${result.error}`,
            })
          return Schema.decodeUnknownSync(WebResult)(JSON.parse(result.result))
        } finally {
          this.running = false
          this.controller = null
        }
      },
      catch: (cause) =>
        cause instanceof AppConflict
          ? cause
          : new AppConflict({
              message:
                "The app could not render within its limits. Its saved state is unchanged.",
            }),
    })
  }
  render(input: typeof RenderWebApp.Type, signal: AbortSignal) {
    return Effect.gen({ self: this }, function* () {
      const generation = this.generation
      const snapshot = yield* Effect.try(() => {
        const app = this.store.detail(input.id).app,
          version = this.store.version(input.id, input.version)
        const block = version.definition.blocks[0]
        if (block?.type !== "web")
          throw new AppConflict({ message: "This version is not a web app." })
        return { app, version, block }
      })
      const { app, version, block } = snapshot
      const result = yield* this.run(
        block,
        app.publishedVersion === input.version
          ? (app.state.web?.[block.id] ?? block.initialState)
          : block.initialState,
        null,
        signal
      )
      const html = yield* Effect.try(() => appHtml(result.html))
      yield* Effect.try(() => {
        signal.throwIfAborted()
        if (generation !== this.generation)
          throw new AppConflict({
            message: "This app action was cancelled when its bot was archived.",
          })
      })
      return {
        id: app.id,
        version: version.version,
        revision: app.revision,
        html,
        css: result.css,
      }
    })
  }
  interact(input: InteractApp, signal: AbortSignal) {
    return Effect.gen({ self: this }, function* () {
      const generation = this.generation
      const replay = yield* Effect.try(() =>
        this.store.interactionReceipt(input)
      )
      if (replay) return replay
      const snapshot = yield* Effect.try(() => {
        const app = this.store.interactionSnapshot(input),
          block = this.store
            .version(input.id, input.version)
            .definition.blocks.find(
              (value) => value.id === input.action.blockId
            )
        if (block?.type !== "web" || input.action.type !== "web")
          throw new AppConflict({ message: "This action is not available." })
        return { app, block }
      })
      const { app, block } = snapshot
      const result = yield* this.run(
        block,
        app.state.web?.[block.id] ?? block.initialState,
        input.action,
        signal
      )
      // Reject malformed render output before changing durable state or emitting an event.
      yield* Effect.try(() => appHtml(result.html))
      return yield* Effect.try(() => {
        signal.throwIfAborted()
        if (generation !== this.generation)
          throw new AppConflict({
            message: "This app action was cancelled when its bot was archived.",
          })
        return this.store.interact(input, result)
      })
    })
  }
}
