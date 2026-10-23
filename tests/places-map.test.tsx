import { it } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"

import {
  acquirePlacesMap,
  openPlacesMap,
  type MapPlatform,
} from "../src/features/rich-results/places-map-resource"
import {
  placesMapMachine,
  type MapView,
} from "../src/features/rich-results/places-map.machine"

const view: MapView = {
  revision: 0,
  selected: 0,
  dark: false,
  coordinates: undefined,
  places: [
    { name: "First", address: "Dublin", latitude: 53.34, longitude: -6.25 },
    { name: "Second", address: "Dublin", latitude: 53.35, longitude: -6.26 },
  ],
}
function platform(failAt?: string, autoLoad = true) {
  const calls: string[] = []
  const pressed: string[] = []
  const centers: unknown[] = []
  let loaded: (() => void) | undefined
  const step = (name: string) => {
    calls.push(name)
    if (failAt === name) throw new Error(name)
  }
  let marker = 0
  let button = 0
  class Map {
    constructor() {
      step("map")
    }
    remove() {
      step("remove")
    }
    addControl() {
      step("control")
    }
    on(_name: string, callback: () => void) {
      step("listen")
      loaded = callback
      if (autoLoad) callback()
    }
    off() {
      step("unlisten")
      loaded = undefined
    }
    resize() {
      step("resize")
    }
    addSource() {
      step("source")
    }
    addLayer() {
      step("layer")
    }
    fitBounds() {
      step("fit")
    }
    easeTo(options: unknown) {
      centers.push(options)
      step("select")
    }
  }
  class Marker {
    id = ++marker
    constructor() {
      step(`marker${this.id}`)
    }
    setLngLat() {
      return this
    }
    addTo() {
      step(`attach${this.id}`)
      return this
    }
    remove() {
      step(`removeMarker${this.id}`)
    }
  }
  const native = {
    container: {} as HTMLElement,
    load: () =>
      Promise.resolve({
        Map,
        Marker,
        NavigationControl: class {},
        LngLatBounds: class {
          extend() {}
        },
      } as unknown as Awaited<ReturnType<MapPlatform["load"]>>),
    createButton: () => {
      const id = button++
      return {
        setAttribute: (name: string, value: string) => {
          if (name === "aria-pressed") pressed[id] = value
        },
        addEventListener: () => step(`click${id}`),
        removeEventListener: () => step(`unclick${id}`),
      } as unknown as HTMLButtonElement
    },
    createResizeObserver: () =>
      ({
        observe: () => step("observe"),
        disconnect: () => step("disconnect"),
      }) as unknown as ResizeObserver,
    routeColor: () => "#000000",
    reducedMotion: () => true,
    onSelect: () => {},
  } satisfies MapPlatform
  return { native, calls, pressed, centers, load: () => loaded?.() }
}

for (const failure of [
  "control",
  "attach2",
  "observe",
  "source",
  "layer",
  "fit",
]) {
  it.effect(
    `releases every earlier map acquisition when ${failure} fails`,
    () =>
      Effect.gen(function* () {
        const fixture = platform(failure)
        const exit = yield* acquirePlacesMap(
          {
            ...view,
            coordinates: [
              [-6.25, 53.34],
              [-6.26, 53.35],
            ],
          },
          fixture.native
        ).pipe(Effect.scoped, Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(
          fixture.calls.filter((value) => value === "remove")
        ).toHaveLength(1)
        if (failure !== "control") {
          expect(fixture.calls).toContain("removeMarker1")
          expect(fixture.calls).toContain("removeMarker2")
          expect(fixture.calls).toContain("unclick0")
          expect(fixture.calls).toContain("unclick1")
        }
        if (["observe", "source", "layer", "fit"].includes(failure))
          expect(fixture.calls).toContain("disconnect")
      })
  )
}

it.effect(
  "does not acquire a replacement until release joins and retains only the latest view",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const calls: number[] = []
      const actor = yield* createEffectActor(
        placesMapMachine((input) =>
          Effect.sync(() => {
            calls.push(input.revision)
            return {
              ready: Effect.void,
              select: () => Effect.void,
              close:
                input.revision === 0
                  ? Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(release))
                    )
                  : Effect.void,
            }
          })
        ),
        { input: view }
      )
      yield* waitFor(actor, (state) => state.matches({ active: "ready" }))
      yield* send(actor, { type: "VIEW", ...view, revision: 1 })
      yield* Deferred.await(entered)
      yield* send(actor, { type: "VIEW", ...view, revision: 2 })
      yield* Effect.yieldNow
      expect(calls).toEqual([0])
      yield* Deferred.succeed(release, undefined)
      yield* waitFor(
        actor,
        (state) =>
          state.matches({ active: "ready" }) &&
          state.context.current.revision === 2
      )
      expect(calls).toEqual([0, 2])
    }).pipe(Effect.scoped)
)

it.effect(
  "keeps fallback occupancy and recovers on a late load with current selection",
  () =>
    Effect.gen(function* () {
      const loaded = yield* Deferred.make<void>()
      const selections: number[] = []
      const applied = yield* Deferred.make<void>()
      const actor = yield* createEffectActor(
        placesMapMachine(() =>
          Effect.succeed({
            ready: Deferred.await(loaded),
            select: (selected) =>
              Effect.sync(() => {
                selections.push(selected)
              }).pipe(Effect.andThen(Deferred.succeed(applied, undefined))),
            close: Effect.void,
          })
        ),
        { input: view }
      )
      yield* waitFor(actor, (state) => state.matches({ active: "loading" }))
      yield* TestClock.adjust(15000)
      yield* waitFor(actor, (state) =>
        state.matches({ active: "fallbackLoading" })
      )
      yield* send(actor, { type: "VIEW", ...view, selected: 1 })
      yield* Deferred.succeed(loaded, undefined)
      yield* waitFor(actor, (state) => state.matches({ active: "ready" }))
      yield* Deferred.await(applied)
      expect(selections.at(-1)).toBe(1)
    }).pipe(Effect.scoped)
)

it.effect(
  "a stale load cannot restore a replaced map and malformed views cannot replace it",
  () =>
    Effect.gen(function* () {
      const old = yield* Deferred.make<void>()
      const actor = yield* createEffectActor(
        placesMapMachine((input) =>
          Effect.succeed({
            ready: input.revision === 0 ? Deferred.await(old) : Effect.void,
            select: () => Effect.void,
            close: Effect.void,
          })
        ),
        { input: view }
      )
      yield* waitFor(actor, (state) => state.matches({ active: "loading" }))
      yield* send(actor, { type: "VIEW", ...view, revision: 1 })
      yield* waitFor(
        actor,
        (state) =>
          state.matches({ active: "ready" }) &&
          state.context.current.revision === 1
      )
      yield* Deferred.succeed(old, undefined)
      yield* send(actor, { type: "VIEW", ...view, revision: -1 })
      yield* Effect.yieldNow
      expect(actor.getSnapshot().context.current.revision).toBe(1)
      expect(actor.getSnapshot().matches({ active: "ready" })).toBe(true)
    }).pipe(Effect.scoped)
)

it.effect("blocks replacement after failed release", () =>
  Effect.gen(function* () {
    let opens = 0
    const actor = yield* createEffectActor(
      placesMapMachine(() =>
        Effect.sync(() => {
          opens++
          return {
            ready: Effect.void,
            select: () => Effect.void,
            close: Effect.die("remove failed"),
          }
        })
      ),
      { input: view }
    )
    yield* waitFor(actor, (state) => state.matches({ active: "ready" }))
    yield* send(actor, { type: "VIEW", ...view, revision: 1 })
    yield* waitFor(actor, (state) => state.matches("blocked"))
    yield* send(actor, { type: "VIEW", ...view, revision: 2 })
    yield* Effect.yieldNow
    expect(opens).toBe(1)
  }).pipe(Effect.scoped)
)

it.effect(
  "joins held module settlement on disposal without creating a stale map",
  () =>
    Effect.gen(function* () {
      const fixture = platform()
      let resolve!: (lib: Awaited<ReturnType<MapPlatform["load"]>>) => void
      const pending = new Promise<Awaited<ReturnType<MapPlatform["load"]>>>(
        (release) => {
          resolve = release
        }
      )
      const started = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      const session = yield* openPlacesMap(view, {
        ...fixture.native,
        load: () => {
          Deferred.doneUnsafe(started, Effect.void)
          return pending
        },
      }).pipe(Scope.provide(scope))
      yield* Deferred.await(started)
      const close = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(close.pollUnsafe()).toBeUndefined()
      resolve(yield* Effect.promise(fixture.native.load))
      yield* Fiber.join(close)
      expect(fixture.calls).not.toContain("map")
      const result = yield* Effect.exit(session.ready)
      expect(Exit.isFailure(result)).toBe(true)
    })
)

it.effect(
  "applies selection to a ready map and releases all native resources on close",
  () =>
    Effect.gen(function* () {
      const fixture = platform()
      const scope = yield* Scope.make()
      const session = yield* openPlacesMap(view, fixture.native).pipe(
        Scope.provide(scope)
      )
      yield* session.ready
      yield* session.select(1)
      expect(fixture.pressed).toEqual(["false", "true"])
      expect(fixture.centers).toEqual([{ center: [-6.26, 53.35], duration: 0 }])
      yield* session.close
      yield* session.select(0)
      yield* Scope.close(scope, Exit.void)
      expect(fixture.centers).toHaveLength(1)
      expect(fixture.calls.filter((value) => value === "remove")).toHaveLength(
        1
      )
      expect(fixture.calls).toContain("disconnect")
      expect(fixture.calls).toContain("unlisten")
    })
)

it.effect(
  "one failing native release does not skip remaining map finalizers",
  () =>
    Effect.gen(function* () {
      const fixture = platform("removeMarker2")
      const exit = yield* acquirePlacesMap(view, fixture.native).pipe(
        Effect.scoped,
        Effect.exit
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(fixture.calls).toContain("removeMarker1")
      expect(fixture.calls).toContain("unclick0")
      expect(fixture.calls).toContain("unclick1")
      expect(fixture.calls).toContain("disconnect")
      expect(fixture.calls).toContain("remove")
    })
)
