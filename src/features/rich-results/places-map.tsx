import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url"
import { useTheme } from "next-themes"
import { useEffect, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import "maplibre-gl/dist/maplibre-gl.css"
import { Skeleton } from "@/components/ui/skeleton"
import type { AnswerProps } from "@/rich-results/catalog"

import { openPlacesMap } from "./places-map-resource"
import { placesMapMachine, type MapView } from "./places-map.machine"

type Props = {
  places: AnswerProps<"Places">["places"]
  selected: number
  onSelect: (index: number) => void
  coordinates?: AnswerProps<"Route">["coordinates"]
}
type MapMachine = ReturnType<typeof placesMapMachine>

export function PlacesMap({ places, selected, onSelect, coordinates }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const select = useRef(onSelect)
  const { resolvedTheme } = useTheme()
  const dark = resolvedTheme === "dark"
  const sent = useRef({ places, coordinates, dark, revision: 0 })
  const [actor, setActor] = useState<EffectActor<MapMachine> | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<MapMachine> | null>(
    null
  )
  useEffect(() => {
    select.current = onSelect
  }, [onSelect])
  useEffect(() => {
    const element = container.current
    if (!element) return
    let mounted = true
    const input: MapView = { ...sent.current, selected }
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const owned = yield* createEffectActor(
          placesMapMachine((view) =>
            openPlacesMap(view, {
              container: element,
              load: () =>
                import("maplibre-gl").then((lib) => {
                  lib.setWorkerUrl(workerUrl)
                  return lib
                }),
              createButton: () => document.createElement("button"),
              createResizeObserver: (callback) => new ResizeObserver(callback),
              routeColor: () =>
                getComputedStyle(element)
                  .getPropertyValue("--primary")
                  .trim() || "#535fc6",
              reducedMotion: () =>
                window.matchMedia("(prefers-reduced-motion: reduce)").matches,
              onSelect: (index) => select.current(index),
            })
          ),
          { input }
        )
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            owned.subscribe((value) => {
              if (mounted) setSnapshot(value)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        if (mounted) {
          setActor(owned)
          setSnapshot(owned.getSnapshot())
        }
        return yield* Effect.never
      }).pipe(Effect.scoped)
    )
    return () => {
      mounted = false
      // The owner joins map/import/listener finalizers; notifications are detached first.
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
    // Configuration changes are machine events; the container has one owner.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!actor) return
    const previous = sent.current
    const changed =
      previous.places !== places ||
      previous.coordinates !== coordinates ||
      previous.dark !== dark
    sent.current = {
      places,
      coordinates,
      dark,
      revision: previous.revision + Number(changed),
    }
    Effect.runFork(send(actor, { type: "VIEW", ...sent.current, selected }))
  }, [actor, places, coordinates, dark, selected])
  const status = snapshot?.matches({ active: "ready" })
    ? "ready"
    : snapshot?.matches({ active: "fallbackLoading" }) ||
        snapshot?.matches("unavailable") ||
        snapshot?.matches("blocked")
      ? "unavailable"
      : "loading"
  const place = places[selected] ?? places[0]!
  return (
    <div
      className="relative h-72 min-w-0 overflow-hidden rounded-lg border bg-muted"
      role="region"
      aria-label="Interactive place map"
    >
      <div
        ref={container}
        className="size-full"
        aria-hidden={status === "unavailable"}
        inert={status === "unavailable"}
      />
      {status === "loading" && (
        <Skeleton
          className="absolute inset-0 size-full"
          aria-label="Loading map"
        />
      )}
      {status === "unavailable" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-muted p-5 text-center">
          <p className="text-sm">The interactive map is unavailable.</p>
          <a
            className="text-sm text-primary underline underline-offset-4"
            href={`https://www.openstreetmap.org/?mlat=${place.latitude}&mlon=${place.longitude}#map=14/${place.latitude}/${place.longitude}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open {place.name} in OpenStreetMap
          </a>
          <p className="text-xs text-muted-foreground">
            Addresses and directions remain available below.
          </p>
        </div>
      )}
    </div>
  )
}
