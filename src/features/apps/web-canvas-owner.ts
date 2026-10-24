import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import { Effect, Schema } from "effect"

import { AppAction, WebPreview } from "@/apps/contracts"
import { agentApi } from "@/http/client"
import { nativeOperation } from "@/shared/interop"

import { appWorkFailures } from "./app-owner"
import {
  webCanvasMachine,
  type FrameWork,
  type FrameEvent,
} from "./web-canvas.machine"
import { webFrame } from "./web-frame"

export type FrameActor = EffectActor<ReturnType<typeof webCanvasMachine>>
export function makeFrameOwner(
  input: { revision: number; disabled: boolean },
  work: FrameWork
) {
  return Effect.gen(function* () {
    const observe = yield* appWorkFailures
    return yield* createEffectActor(
      webCanvasMachine({
        render: observe(work.render),
        action: (action, revision, channel) =>
          observe(work.action(action, revision, channel)),
        bridge: observe(work.bridge),
      }),
      { input }
    )
  })
}
export type FrameHost = {
  agentId: string
  id: string
  version: number
  blockId: string
  frame: () => HTMLIFrameElement | null
  current: () => {
    revision: number
    disabled: boolean
    onAction: (action: AppAction, revision?: number) => Promise<boolean>
  }
}
export function frameWork(
  host: FrameHost,
  owner: Effect.Effect<FrameActor>
): FrameWork {
  const post = (channel: string, enabled: boolean) =>
    host
      .frame()
      ?.contentWindow?.postMessage({ channel, type: "enabled", enabled }, "*")
  return {
    render: nativeOperation(
      (signal) =>
        agentApi(host.agentId)(
          "apps/render",
          { id: host.id, version: host.version },
          signal
        ),
      (cause) => cause
    ).pipe(
      Effect.map(Schema.decodeUnknownSync(WebPreview)),
      Effect.flatMap((preview) =>
        preview.id === host.id && preview.version === host.version
          ? Effect.sync(() => {
              const channel = crypto.randomUUID()
              return {
                preview,
                channel,
                html: webFrame(preview.html, preview.css, channel),
              }
            })
          : Effect.fail(new Error("App preview identity changed."))
      )
    ),
    action: (action, revision, channel) =>
      Effect.gen(function* () {
        const actor = yield* owner
        return yield* nativeOperation(
          () => {
            const current = host.current(),
              source = actor.getSnapshot().context.source
            return current.disabled ||
              current.revision !== revision ||
              source?.channel !== channel
              ? Promise.resolve(false)
              : current.onAction(action, revision)
          },
          (cause) => cause
        )
      }),
    bridge: Effect.gen(function* () {
      const actor = yield* owner
      const receive = (event: MessageEvent<unknown>) => {
        const source = actor.getSnapshot().context.source,
          data = Schema.decodeUnknownOption(
            Schema.Record(Schema.String, Schema.Unknown)
          )(event.data)
        if (
          !source ||
          event.origin !== "null" ||
          event.source !== host.frame()?.contentWindow ||
          data._tag !== "Some" ||
          data.value.channel !== source.channel
        )
          return
        const message = data.value
        let next: FrameEvent | undefined
        if (message.type === "ready")
          next = { type: "READY", channel: source.channel }
        if (
          message.type === "height" &&
          typeof message.height === "number" &&
          Number.isFinite(message.height)
        )
          next = {
            type: "HEIGHT",
            channel: source.channel,
            height: message.height,
          }
        if (message.type === "error")
          next = { type: "ERROR", channel: source.channel }
        if (message.type === "action") {
          const current = host.current()
          if (current.disabled || current.revision !== source.preview.revision)
            return
          const action = Schema.decodeUnknownOption(AppAction)({
            type: "web",
            blockId: host.blockId,
            name: message.name,
            values: message.values,
          })
          next =
            action._tag === "Some"
              ? {
                  type: "ACTION",
                  channel: source.channel,
                  action: action.value,
                }
              : { type: "ERROR", channel: source.channel }
        }
        if (next) Effect.runFork(send(actor, next))
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => addEventListener("message", receive)),
        () => Effect.sync(() => removeEventListener("message", receive))
      )
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          actor.on("enabled", (event) => post(event.channel, event.enabled))
        ),
        (subscription) =>
          Effect.sync(() => {
            subscription.unsubscribe()
            const source = actor.getSnapshot().context.source
            if (source) post(source.channel, false)
          })
      )
      return yield* Effect.never
    }),
  }
}
