import { MapPin, Navigation, ExternalLink, Calculator } from "lucide-react"
import { useId, useState, type ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { AnswerProps } from "@/rich-results/catalog"

import { PlacesMap } from "./places-map"

type Provenance = {
  source: { label: string; url: string | null }
  asOf: string
}
export function ResultCard({
  title,
  description,
  action,
  provenance,
  children,
}: {
  title: string
  description?: string
  action?: ReactNode
  provenance?: Provenance
  children: ReactNode
}) {
  return (
    <Card className="rich-result w-full min-w-0 whitespace-normal">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent>{children}</CardContent>
      {provenance && (
        <CardFooter className="flex-wrap justify-between gap-2">
          {provenance.source.url ? (
            <a
              className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:underline"
              href={provenance.source.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {provenance.source.label}
              <ExternalLink className="size-3" aria-hidden="true" />
            </a>
          ) : (
            <span className="text-xs text-muted-foreground">
              {provenance.source.label}
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            As of {provenance.asOf}
          </span>
        </CardFooter>
      )}
    </Card>
  )
}
export function CalculationCard(props: AnswerProps<"Calculation">) {
  return (
    <ResultCard
      title={props.title}
      action={
        <Calculator
          className="size-5 text-muted-foreground"
          aria-hidden="true"
        />
      }
    >
      <div className="flex flex-col gap-2">
        <code className="text-sm text-muted-foreground">
          {props.expression}
        </code>
        <p className="text-3xl font-medium tracking-tight break-words tabular-nums">
          {props.result.toLocaleString("en-IE", {
            maximumSignificantDigits: 14,
          })}{" "}
          <span className="text-base text-muted-foreground">{props.unit}</span>
        </p>
        {props.explanation && (
          <p className="text-sm text-muted-foreground">{props.explanation}</p>
        )}
      </div>
    </ResultCard>
  )
}
export function PlacesCard(props: AnswerProps<"Places">) {
  const [selected, setSelected] = useState(0)
  const place = props.places[selected] ?? props.places[0]!
  return (
    <ResultCard
      title={props.title}
      description={`${props.places.length} ${props.places.length === 1 ? "place" : "places"} · Select a place to view its map`}
      action={<MapPin className="size-5 text-primary" aria-hidden="true" />}
      provenance={props}
    >
      <div className="flex flex-col gap-3">
        <PlacesMap
          places={props.places}
          selected={selected}
          onSelect={setSelected}
        />
        <p className="text-xs text-muted-foreground">
          Map data © OpenStreetMap contributors
        </p>
        <div className="flex flex-col gap-2" role="group" aria-label="Places">
          {props.places.map((item, index) => (
            <Button
              className="h-auto justify-start py-2 text-left whitespace-normal"
              key={`${item.latitude}:${item.longitude}:${index}`}
              variant={index === selected ? "secondary" : "ghost"}
              aria-pressed={index === selected}
              onClick={() => setSelected(index)}
            >
              <MapPin data-icon="inline-start" />
              <span className="flex min-w-0 flex-col gap-1">
                <span>{item.name}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {item.address}
                </span>
              </span>
            </Button>
          ))}
        </div>
        <a
          href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${place.latitude},${place.longitude}`)}`}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({
            variant: "outline",
            className: "self-start",
          })}
        >
          <Navigation data-icon="inline-start" />
          Get directions
        </a>
      </div>
    </ResultCard>
  )
}
export function RouteCard(props: AnswerProps<"Route">) {
  const [selected, setSelected] = useState(0)
  const directions = new URL("https://www.google.com/maps/dir/")
  directions.search = new URLSearchParams({
    api: "1",
    origin: `${props.stops[0]!.latitude},${props.stops[0]!.longitude}`,
    destination: `${props.stops.at(-1)!.latitude},${props.stops.at(-1)!.longitude}`,
    waypoints: props.stops
      .slice(1, -1)
      .map((stop) => `${stop.latitude},${stop.longitude}`)
      .join("|"),
    travelmode: "driving",
  }).toString()
  return (
    <ResultCard
      title={props.title}
      description="Driving estimate · no live traffic"
      provenance={props}
      action={<Navigation className="size-5 text-primary" aria-hidden="true" />}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline gap-4">
          <p className="text-3xl font-medium tracking-tight tabular-nums">
            {(props.distanceMeters / 1000).toLocaleString("en-IE", {
              maximumFractionDigits: 1,
            })}{" "}
            <span className="text-sm text-muted-foreground">km</span>
          </p>
          <p className="text-lg tabular-nums">
            {Math.max(1, Math.round(props.durationSeconds / 60))} min
          </p>
        </div>
        <PlacesMap
          places={props.stops}
          coordinates={props.coordinates}
          selected={selected}
          onSelect={setSelected}
        />
        <ol className="flex flex-col gap-2" aria-label="Route stops">
          {props.stops.map((place, index) => (
            <li key={index}>
              <Button
                variant={selected === index ? "secondary" : "ghost"}
                aria-pressed={selected === index}
                onClick={() => setSelected(index)}
                className="h-auto w-full justify-start py-2 text-left whitespace-normal"
              >
                <MapPin data-icon="inline-start" />
                <span>
                  {index + 1}. {place.name}
                  <span className="block text-xs font-normal text-muted-foreground">
                    {place.address}
                  </span>
                </span>
              </Button>
            </li>
          ))}
        </ol>
        <a
          href={directions.href}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({
            variant: "outline",
            className: "self-start",
          })}
        >
          <Navigation data-icon="inline-start" />
          Open driving directions
        </a>
      </div>
    </ResultCard>
  )
}
export function ComparisonTable({
  options,
  criteria,
  title,
}: Pick<AnswerProps<"Comparison">, "options" | "criteria" | "title">) {
  return (
    <Table
      containerProps={{
        tabIndex: 0,
        role: "region",
        "aria-label": `${title} comparison. Scroll horizontally to see all options.`,
        className:
          "rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
      }}
    >
      <TableCaption className="sr-only">{title}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Compare</TableHead>
          {options.map((name, index) => (
            <TableHead key={index}>{name}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {criteria.map((row, index) => (
          <TableRow key={index}>
            <TableHead scope="row">{row.label}</TableHead>
            {row.values.map((value, i) => (
              <TableCell className="max-w-64 whitespace-normal" key={i}>
                {value}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
export function ComparisonCard(props: AnswerProps<"Comparison">) {
  return (
    <ResultCard title={props.title} provenance={props}>
      <div className="flex flex-col gap-4">
        <ComparisonTable {...props} />
        <p className="text-sm">
          <Badge variant="secondary">The trade-off</Badge> {props.verdict}
        </p>
      </div>
    </ResultCard>
  )
}
export function BarChartCard(props: AnswerProps<"BarChart">) {
  const max = Math.max(...props.values.map((item) => item.value)) || 1
  const id = useId()
  return (
    <ResultCard title={props.title} description={props.unit} provenance={props}>
      <figure aria-labelledby={id} className="flex flex-col gap-3">
        <figcaption id={id} className="sr-only">
          {props.title} in {props.unit}
        </figcaption>
        {props.values.map((item, index) => (
          <div className="flex flex-col gap-1" key={index}>
            <div className="flex justify-between gap-3 text-sm">
              <span>{item.label}</span>
              <span className="tabular-nums">
                {item.value.toLocaleString("en-IE")} {props.unit}
              </span>
            </div>
            <div
              className="h-2 overflow-hidden rounded-full bg-muted"
              aria-hidden="true"
            >
              <div
                className="rich-result-bar h-full rounded-full bg-primary"
                style={{ width: `${(item.value / max) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </figure>
    </ResultCard>
  )
}
export function TimelineCard(props: AnswerProps<"Timeline">) {
  return (
    <ResultCard title={props.title} provenance={props}>
      <ol className="flex flex-col gap-4">
        {props.events.map((event, index) => (
          <li key={index} className="grid grid-cols-[5rem_1fr] gap-3">
            <span className="text-xs text-muted-foreground">{event.when}</span>
            <div className="flex flex-col gap-1 border-l pl-4">
              <p className="text-sm font-medium">{event.title}</p>
              <p className="text-sm text-muted-foreground">{event.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </ResultCard>
  )
}
