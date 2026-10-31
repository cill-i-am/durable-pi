import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { DataLoading } from "@workspace/ui/components/data-loading"
import { send } from "@xstate/effect"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { useEffect, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import type { AppAction } from "@/apps/contracts"

import { frameWork, makeFrameOwner, type FrameActor } from "./web-canvas-owner"
import type { webCanvasMachine } from "./web-canvas.machine"

type Props = {
  agentId: string
  id: string
  version: number
  revision: number
  blockId: string
  title: string
  disabled: boolean
  onAction: (action: AppAction, expectedRevision?: number) => Promise<boolean>
}
export function WebCanvas(props: Props) {
  return (
    <OwnedWebCanvas
      key={`${props.agentId}/${props.id}/${props.version}/${props.blockId}`}
      {...props}
    />
  )
}
function OwnedWebCanvas({
  agentId,
  id,
  version,
  revision,
  blockId,
  title,
  disabled,
  onAction,
}: Props) {
  const frame = useRef<HTMLIFrameElement>(null),
    current = useRef({ revision, disabled, onAction })
  current.current = { revision, disabled, onAction }
  const [owner, setOwner] = useState<FrameActor | null>(null),
    [snapshot, setSnapshot] = useState<SnapshotFrom<
      ReturnType<typeof webCanvasMachine>
    > | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<FrameActor>()
        const actor = yield* makeFrameOwner(
          {
            revision: current.current.revision,
            disabled: current.current.disabled,
          },
          frameWork(
            {
              agentId,
              id,
              version,
              blockId,
              frame: () => frame.current,
              current: () => ({
                ...current.current,
                disabled:
                  current.current.disabled || !frameAvailable(frame.current),
              }),
            },
            Deferred.await(ready)
          )
        )
        yield* Deferred.succeed(ready, actor)
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            actor.subscribe((value) => {
              if (mounted) setSnapshot(value)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        if (mounted) {
          setOwner(actor)
          setSnapshot(actor.getSnapshot())
        }
        return yield* Effect.never
      }).pipe(Effect.scoped)
    )
    return () => {
      mounted = false
      Effect.runFork(
        Fiber.interrupt(fiber).pipe(
          Effect.andThen(Fiber.await(fiber)),
          Effect.flatMap((exit) =>
            Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
              ? Effect.logError(exit.cause)
              : Effect.void
          )
        )
      )
    }
  }, [agentId, id, version, blockId])
  useEffect(() => {
    if (owner) Effect.runFork(send(owner, { type: "SYNC", revision, disabled }))
  }, [owner, revision, disabled])
  const source = snapshot?.context.source,
    preview = source?.preview,
    error = snapshot?.context.error ?? "",
    height = snapshot?.context.height ?? 400
  const loading = !snapshot || snapshot.matches({ owned: "rendering" }),
    acting = snapshot?.matches({ owned: "acting" }) ?? false
  const outdated = !!preview && preview.revision !== revision
  const reload = () =>
    owner && Effect.runPromise(send(owner, { type: "RELOAD" }))
  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      aria-label="Cloudflare app"
    >
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={loading || acting}
          onClick={() => void reload()}
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
          onLoad={() => {
            if (owner)
              Effect.runFork(
                send(owner, { type: "READY", channel: source.channel })
              )
          }}
        />
      ) : loading ? (
        <DataLoading loading label="Loading app preview" layout="media" />
      ) : null}
    </section>
  )
}

function frameAvailable(frame: HTMLIFrameElement | null) {
  return (
    !!frame &&
    frame.getClientRects().length > 0 &&
    !frame.closest('[inert], [data-base-ui-inert], [aria-hidden="true"]')
  )
}
