import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import type { Map as LibreMap } from "maplibre-gl"

import { nativeOperation } from "@/shared/interop"

import type { MapSession, MapView } from "./places-map.machine"

type MapLibrary = typeof import("maplibre-gl")
export type MapPlatform = {
  readonly container: HTMLElement
  readonly load: () => Promise<MapLibrary>
  readonly createButton: () => HTMLButtonElement
  readonly createResizeObserver: (callback: () => void) => ResizeObserver
  readonly routeColor: () => string
  readonly reducedMotion: () => boolean
  readonly onSelect: (index: number) => void
}
const clamp = (latitude: number) => Math.max(-85, Math.min(85, latitude))
const attempt = <A>(work: () => A) =>
  Effect.try({ try: work, catch: (cause) => cause })
type MapControl = { readonly select: (index: number) => void }

function prepareRoute(
  map: LibreMap,
  lib: MapLibrary,
  view: MapView,
  platform: MapPlatform
) {
  if (view.coordinates) {
    map.addSource("route", {
      type: "geojson",
      data: {
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: view.coordinates.map((point) => [...point]),
        },
      },
    })
    map.addLayer({
      id: "route",
      type: "line",
      source: "route",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": platform.routeColor(), "line-width": 4 },
    })
  }
  const points =
    view.coordinates ??
    view.places.map((place) => [place.longitude, place.latitude] as const)
  if (points.length > 1) {
    const bounds = new lib.LngLatBounds()
    points.forEach((point) => bounds.extend([point[0], clamp(point[1])]))
    map.fitBounds(bounds, { padding: 48, maxZoom: 14, duration: 0 })
  }
}

/** Each successful native acquisition registers its own release immediately. */
export function acquirePlacesMap(view: MapView, platform: MapPlatform) {
  return Effect.gen(function* () {
    const lib = yield* nativeOperation(
      () => platform.load(),
      (cause) => cause
    )
    const map = yield* Effect.acquireRelease(
      attempt(
        () =>
          new lib.Map({
            container: platform.container,
            style: view.dark
              ? "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
              : "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
            center: [
              view.places[0]!.longitude,
              clamp(view.places[0]!.latitude),
            ],
            zoom: 13,
            attributionControl: { compact: true },
            cooperativeGestures: true,
          })
      ),
      (value) => Effect.sync(() => value.remove())
    )
    yield* attempt(() =>
      map.addControl(
        new lib.NavigationControl({ showCompass: false }),
        "top-right"
      )
    )
    const buttons: HTMLButtonElement[] = []
    for (const [index, place] of view.places.entries()) {
      const button = yield* attempt(platform.createButton)
      button.type = "button"
      button.className = "rich-map-pin"
      button.textContent = String(index + 1)
      button.setAttribute("aria-label", `Show ${place.name} on map`)
      button.setAttribute("aria-pressed", String(index === view.selected))
      const click = () => platform.onSelect(index)
      yield* Effect.acquireRelease(
        attempt(() => button.addEventListener("click", click)),
        () => Effect.sync(() => button.removeEventListener("click", click))
      )
      const marker = yield* Effect.acquireRelease(
        attempt(() => new lib.Marker({ element: button })),
        (value) => Effect.sync(() => value.remove())
      )
      yield* attempt(() =>
        marker.setLngLat([place.longitude, clamp(place.latitude)]).addTo(map)
      )
      buttons.push(button)
    }
    const resize = yield* Effect.acquireRelease(
      attempt(() => platform.createResizeObserver(() => map.resize())),
      (value) => Effect.sync(() => value.disconnect())
    )
    yield* attempt(() => resize.observe(platform.container))
    const loaded = yield* Deferred.make<void>()
    const onLoad = () => {
      Deferred.doneUnsafe(loaded, Effect.void)
    }
    yield* Effect.acquireRelease(
      attempt(() => map.on("load", onLoad)),
      () =>
        Effect.sync(() => {
          map.off("load", onLoad)
        })
    )
    yield* Deferred.await(loaded)
    yield* attempt(() => prepareRoute(map, lib, view, platform))
    // The default first selection preserves the initial fit-to-all view.
    // A non-default selection on replacement restores its previous focus.
    let selected: number | undefined = view.selected === 0 ? 0 : undefined
    return {
      select: (index: number) => {
        buttons.forEach((button, position) =>
          button.setAttribute("aria-pressed", String(index === position))
        )
        const place = view.places[index]
        if (!place || index === selected) return
        selected = index
        map.easeTo({
          center: [place.longitude, clamp(place.latitude)],
          duration: platform.reducedMotion() ? 0 : 250,
        })
      },
    } satisfies MapControl
  })
}

/** The feature scope holds the lease across loading and ready, and joins close. */
export function openPlacesMap(
  view: MapView,
  platform: MapPlatform
): Effect.Effect<MapSession, never, Scope.Scope> {
  return Effect.gen(function* () {
    let closed = false
    const scope = yield* Effect.acquireRelease(Scope.make(), (value) =>
      Effect.sync(() => {
        closed = true
      }).pipe(Effect.andThen(Scope.close(value, Exit.void)))
    )
    let control: MapControl | undefined
    const work = yield* acquirePlacesMap(view, platform).pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          control = value
        })
      ),
      Scope.provide(scope),
      Effect.forkIn(scope)
    )
    return {
      ready: Fiber.join(work).pipe(Effect.asVoid),
      select: (index) =>
        attempt(() => {
          if (!closed) control?.select(index)
        }),
      close: Effect.sync(() => {
        closed = true
      }).pipe(Effect.andThen(Scope.close(scope, Exit.void))),
    }
  })
}
