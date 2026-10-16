import { Schema } from "effect"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { AppAction, WebPreview } from "@/apps/contracts"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { agentApi } from "@/http/client"

import { webFrame } from "./web-frame"

export function WebCanvas({
  agentId,
  id,
  version,
  revision,
  blockId,
  title,
  disabled,
  onAction,
}: {
  agentId: string
  id: string
  version: number
  revision: number
  blockId: string
  title: string
  disabled: boolean
  onAction: (action: AppAction, expectedRevision?: number) => Promise<boolean>
}) {
  const [preview, setPreview] = useState<WebPreview | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [height, setHeight] = useState(400),
    [acting, setActing] = useState(false)
  const sequence = useRef(0),
    frame = useRef<HTMLIFrameElement>(null),
    actionLock = useRef(false),
    rendering = useRef<{ key: string; promise: Promise<WebPreview> } | null>(
      null
    )
  const source = useMemo(() => {
    if (!preview) return null
    const channel = crypto.randomUUID()
    return { channel, html: webFrame(preview.html, preview.css, channel) }
  }, [preview])
  const load = useCallback(async () => {
    const generation = ++sequence.current
    setLoading(true)
    setError("")
    const key = `${agentId}/${id}/${version}`
    const pending =
      rendering.current?.key === key
        ? rendering.current
        : {
            key,
            promise: agentApi(agentId)("apps/render", { id, version }).then(
              Schema.decodeUnknownSync(WebPreview)
            ),
          }
    rendering.current = pending
    try {
      const result = await pending.promise
      if (generation === sequence.current) setPreview(result)
    } catch (cause) {
      if (generation === sequence.current)
        setError(
          cause instanceof Error ? cause.message : "Could not render this app."
        )
    } finally {
      if (rendering.current === pending) rendering.current = null
      if (generation === sequence.current) setLoading(false)
    }
  }, [agentId, id, version])
  useEffect(() => {
    void load()
    return () => {
      sequence.current++
    }
  }, [load])
  const outdated = !!preview && preview.revision !== revision
  const enabled = !disabled && !loading && !outdated && !acting
  useEffect(() => {
    if (!source) return
    const receive = (event: MessageEvent<unknown>) => {
      const data = Schema.decodeUnknownOption(
        Schema.Record(Schema.String, Schema.Unknown)
      )(event.data)
      if (data._tag !== "Some") return
      const message = data.value
      const frameWindow = frame.current?.contentWindow
      if (
        !frameWindow ||
        event.source !== frameWindow ||
        event.origin !== "null" ||
        message.channel !== source.channel
      )
        return
      if (
        message.type === "height" &&
        typeof message.height === "number" &&
        Number.isFinite(message.height)
      )
        setHeight(Math.max(240, Math.min(800, message.height)))
      if (message.type === "ready")
        frameWindow.postMessage(
          { channel: source.channel, type: "enabled", enabled },
          "*"
        )
      if (message.type === "error")
        setError("Check the app's field names and limits before submitting.")
      if (message.type !== "action" || !enabled || !preview) return
      const action = Schema.decodeUnknownOption(AppAction)({
        type: "web",
        blockId,
        name: message.name,
        values: message.values,
      })
      if (action._tag !== "Some") {
        setError("The app produced an invalid action.")
        frameWindow.postMessage(
          { channel: source.channel, type: "enabled", enabled },
          "*"
        )
        return
      }
      if (actionLock.current) return
      actionLock.current = true
      setActing(true)
      void onAction(action.value, preview.revision)
        .then(async (saved) => {
          if (saved) await load()
        })
        .catch(() =>
          setError(
            "The change could not finish. Check the app status before retrying."
          )
        )
        .finally(() => {
          actionLock.current = false
          setActing(false)
        })
    }
    addEventListener("message", receive)
    frame.current?.contentWindow?.postMessage(
      { channel: source.channel, type: "enabled", enabled },
      "*"
    )
    return () => removeEventListener("message", receive)
  }, [source, enabled, blockId, preview, onAction, load])
  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      aria-label="Cloudflare app"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Code runs on Cloudflare. Changes stay in this app.
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={loading || acting}
          onClick={() => void load()}
        >
          {loading ? "Rendering…" : "Reload app"}
        </Button>
      </div>
      {outdated && (
        <Alert>
          <AlertDescription>
            This app changed elsewhere. Reload to use its latest saved state;
            unsent fields will be replaced.
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {source ? (
        <iframe
          ref={frame}
          title={title}
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
          srcDoc={source.html}
          className="w-full rounded-lg border bg-background"
          style={{ height }}
          onLoad={() =>
            frame.current?.contentWindow?.postMessage(
              { channel: source.channel, type: "enabled", enabled },
              "*"
            )
          }
        />
      ) : loading ? (
        <Skeleton className="h-60 w-full" />
      ) : null}
    </section>
  )
}
