import type { Map as LibreMap } from "maplibre-gl"
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url"
import { useTheme } from "next-themes"
import { useEffect, useRef, useState } from "react"

import "maplibre-gl/dist/maplibre-gl.css"
import { Skeleton } from "@/components/ui/skeleton"
import type { AnswerProps } from "@/rich-results/catalog"

type Props = {
  places: AnswerProps<"Places">["places"]
  selected: number
  onSelect: (index: number) => void
  coordinates?: AnswerProps<"Route">["coordinates"]
}

export function PlacesMap({ places, selected, onSelect, coordinates }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<LibreMap | null>(null)
  const buttons = useRef<HTMLButtonElement[]>([])
  const lastSelected = useRef(selected)
  const select = useRef(onSelect)
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">(
    "loading"
  )
  const { resolvedTheme } = useTheme()
  useEffect(() => {
    select.current = onSelect
  }, [onSelect])
  useEffect(() => {
    let disposed = false
    let cleanup = () => {}
    setStatus("loading")
    void import("maplibre-gl")
      .then((lib) => {
        if (disposed || !container.current) return
        lib.setWorkerUrl(workerUrl)
        const map = new lib.Map({
          container: container.current,
          style:
            resolvedTheme === "dark"
              ? "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
              : "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
          center: [
            places[0]!.longitude,
            Math.max(-85, Math.min(85, places[0]!.latitude)),
          ],
          zoom: 13,
          attributionControl: { compact: true },
          cooperativeGestures: true,
        })
        mapRef.current = map
        map.addControl(
          new lib.NavigationControl({ showCompass: false }),
          "top-right"
        )
        const markers = places.map((place, index) => {
          const button = document.createElement("button")
          button.type = "button"
          button.className = "rich-map-pin"
          button.textContent = String(index + 1)
          button.setAttribute("aria-label", `Show ${place.name} on map`)
          button.setAttribute("aria-pressed", String(index === 0))
          button.addEventListener("click", () => select.current(index))
          buttons.current[index] = button
          return new lib.Marker({ element: button })
            .setLngLat([
              place.longitude,
              Math.max(-85, Math.min(85, place.latitude)),
            ])
            .addTo(map)
        })
        const timer = window.setTimeout(() => {
          if (!disposed) setStatus("unavailable")
        }, 15000)
        map.on("load", () => {
          if (disposed) return
          window.clearTimeout(timer)
          if (coordinates) {
            map.addSource("route", {
              type: "geojson",
              data: {
                type: "Feature",
                properties: {},
                geometry: { type: "LineString", coordinates },
              },
            })
            map.addLayer({
              id: "route",
              type: "line",
              source: "route",
              layout: { "line-join": "round", "line-cap": "round" },
              paint: {
                "line-color":
                  getComputedStyle(container.current!)
                    .getPropertyValue("--primary")
                    .trim() || "#535fc6",
                "line-width": 4,
              },
            })
          }
          const points =
            coordinates ??
            places.map(
              (place) => [place.longitude, place.latitude] as [number, number]
            )
          if (points.length > 1) {
            const bounds = new lib.LngLatBounds()
            points.forEach((point) =>
              bounds.extend([point[0], Math.max(-85, Math.min(85, point[1]))])
            )
            map.fitBounds(bounds, { padding: 48, maxZoom: 14, duration: 0 })
          }
          setStatus("ready")
        })
        const resize = new ResizeObserver(() => map.resize())
        resize.observe(container.current)
        cleanup = () => {
          clearTimeout(timer)
          resize.disconnect()
          markers.forEach((marker) => marker.remove())
          map.remove()
          mapRef.current = null
          buttons.current = []
        }
      })
      .catch(() => {
        if (!disposed) setStatus("unavailable")
      })
    return () => {
      disposed = true
      cleanup()
    }
  }, [places, coordinates, resolvedTheme])
  useEffect(() => {
    buttons.current.forEach((button, index) =>
      button.setAttribute("aria-pressed", String(index === selected))
    )
    const place = places[selected]
    if (place && status === "ready" && lastSelected.current !== selected) {
      lastSelected.current = selected
      mapRef.current?.easeTo({
        center: [place.longitude, Math.max(-85, Math.min(85, place.latitude))],
        duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 0
          : 250,
      })
    }
  }, [places, selected, status])
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
