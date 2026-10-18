import { cn } from "cn"
import {
  ChevronDown,
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Droplets,
  Sun,
  Sunrise,
  Wind,
  type LucideIcon,
} from "lucide-react"
import type { ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import type { AnswerProps } from "@/rich-results/catalog"
import type { WeatherDay } from "@/rich-results/weather"

import { ResultCard } from "./cards"

function dateLabel(date: string, long = false) {
  return new Intl.DateTimeFormat("en-IE", {
    ...(long ? { year: "numeric" as const } : {}),
    weekday: long ? "long" : "short",
    day: "numeric",
    month: long ? "long" : "short",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`))
}
function localTime(time: string, timezone: string, zone = false) {
  return new Intl.DateTimeFormat("en-IE", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(zone ? { timeZoneName: "short" as const } : {}),
  }).format(new Date(time))
}
function updatedLabel(value: string, timezone: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return value
  return new Intl.DateTimeFormat("en-IE", {
    timeZone: timezone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value))
}

function WeatherIcon({
  condition,
  className,
}: {
  condition: string
  className?: string
}) {
  const icons: [RegExp, LucideIcon][] = [
    [/thunder/i, CloudLightning],
    [/snow/i, CloudSnow],
    [/drizzle/i, CloudDrizzle],
    [/rain|shower/i, CloudRain],
    [/fog/i, CloudFog],
    [/overcast/i, Cloud],
    [/^clear sky$/i, Sun],
  ]
  const Icon =
    icons.find(([pattern]) => pattern.test(condition))?.[1] ?? CloudSun
  return <Icon className={className} aria-hidden="true" />
}

function Metric({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string
  value: ReactNode
  detail?: ReactNode
  icon: LucideIcon
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        {label}
      </dt>
      <dd className="text-sm font-medium tabular-nums">{value}</dd>
      {detail && <dd className="text-xs text-muted-foreground">{detail}</dd>}
    </div>
  )
}

// A named, focusable region lets keyboard users scroll the hourly forecast.
/* oxlint-disable jsx-a11y/no-noninteractive-tabindex */
function HourlyForecast({
  day,
  timezone,
  expanded,
}: {
  day: WeatherDay
  timezone: string
  expanded: boolean
}) {
  if (!day.hours?.length) return null
  return (
    <Collapsible defaultOpen={expanded} className="flex min-w-0 flex-col gap-3">
      <CollapsibleTrigger
        className="group/weather-hours"
        render={
          <Button variant="ghost" size="sm" className="justify-between" />
        }
      >
        Hourly forecast
        <ChevronDown
          data-icon="inline-end"
          className="group-data-[panel-open]/weather-hours:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          role="region"
          aria-label={`Hourly forecast for ${dateLabel(day.date, true)}`}
          tabIndex={0}
          className="relative max-w-full min-w-0 overflow-x-auto rounded-md pb-3 outline-offset-4"
        >
          <ol className="flex gap-5 py-1">
            {day.hours.map((hour) => (
              <li
                key={hour.time}
                className="flex w-20 shrink-0 flex-col items-center gap-2 text-center"
              >
                <time
                  dateTime={hour.time}
                  className="text-xs text-muted-foreground"
                >
                  {localTime(hour.time, timezone, true)}
                </time>
                <WeatherIcon
                  condition={hour.condition}
                  className="size-5 text-primary"
                />
                <span className="sr-only">{hour.condition}</span>
                <dl className="flex flex-col gap-1">
                  <dt className="sr-only">Temperature</dt>
                  <dd className="text-sm font-medium tabular-nums">
                    {Math.round(hour.temperature)}°
                  </dd>
                  {hour.rainPercent !== undefined && (
                    <>
                      <dt className="sr-only">Chance of precipitation</dt>
                      <dd className="inline-flex items-center justify-center gap-1 text-xs text-muted-foreground">
                        <Droplets className="size-3" aria-hidden="true" />
                        {hour.rainPercent}%
                      </dd>
                    </>
                  )}
                  {hour.windKph !== undefined && (
                    <>
                      <dt className="sr-only">Wind</dt>
                      <dd className="text-xs text-muted-foreground">
                        {Math.round(hour.windKph)} km/h
                      </dd>
                    </>
                  )}
                </dl>
              </li>
            ))}
          </ol>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */

function DetailedDay({
  day,
  timezone,
  single,
}: {
  day: WeatherDay
  timezone: string
  single: boolean
}) {
  return (
    <section
      aria-label={dateLabel(day.date, true)}
      className="flex min-w-0 flex-col gap-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">
            <time dateTime={day.date}>{dateLabel(day.date, true)}</time>
          </h2>
          <p className="text-5xl font-medium tracking-tighter tabular-nums">
            {Math.round(day.high)}
            <span className="text-xl text-muted-foreground">°C</span>
          </p>
          <p className="text-sm text-muted-foreground">
            High {Math.round(day.high)}° · Low {Math.round(day.low)}°
          </p>
          <p className="text-sm">{day.condition}</p>
          {day.feelsLikeHigh !== undefined && (
            <p className="text-xs text-muted-foreground">
              Feels like up to {Math.round(day.feelsLikeHigh)}°
            </p>
          )}
        </div>
        <WeatherIcon
          condition={day.condition}
          className="mt-7 size-10 shrink-0 text-primary"
        />
      </div>
      <dl className="grid grid-cols-2 gap-x-5 gap-y-4">
        <Metric
          label="Rain chance"
          value={`${day.rainPercent}%`}
          detail={
            day.rainMm === undefined
              ? undefined
              : `${day.rainMm} mm precipitation`
          }
          icon={Droplets}
        />
        {day.windKph !== undefined && (
          <Metric
            label="Maximum wind"
            value={`${Math.round(day.windKph)} km/h`}
            detail={
              day.gustKph === undefined
                ? undefined
                : `Gusts ${Math.round(day.gustKph)} km/h`
            }
            icon={Wind}
          />
        )}
        {day.uvIndex !== undefined && (
          <Metric
            label="UV index"
            value={day.uvIndex.toLocaleString("en-IE", {
              maximumFractionDigits: 1,
            })}
            icon={Sun}
          />
        )}
        {(day.sunrise || day.sunset) && (
          <Metric
            label="Sunrise / sunset"
            value={`${day.sunrise ? localTime(day.sunrise, timezone) : "—"} / ${day.sunset ? localTime(day.sunset, timezone) : "—"}`}
            icon={Sunrise}
          />
        )}
      </dl>
      <HourlyForecast day={day} timezone={timezone} expanded={single} />
    </section>
  )
}

function ForecastOverview({ days }: { days: WeatherDay[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-6 @sm:grid-cols-4 @2xl:grid-cols-7">
      {days.map((day) => (
        <section
          key={day.date}
          aria-label={dateLabel(day.date, true)}
          className="flex min-w-0 flex-col gap-2"
        >
          <h2 className="text-xs font-medium">
            <time dateTime={day.date}>{dateLabel(day.date)}</time>
          </h2>
          <WeatherIcon
            condition={day.condition}
            className="size-6 text-primary"
          />
          <p className="text-sm tabular-nums">
            <span className="sr-only">High </span>
            {Math.round(day.high)}°{" "}
            <span className="text-muted-foreground">
              <span className="sr-only">Low </span>
              {Math.round(day.low)}°
            </span>
          </p>
          <p className="text-xs text-muted-foreground">{day.condition}</p>
          <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Droplets className="size-3 shrink-0" aria-hidden="true" />
            <span className="sr-only">Rain chance </span>
            {day.rainPercent}%
          </p>
          {day.windKph !== undefined && (
            <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Wind className="size-3 shrink-0" aria-hidden="true" />
              <span className="sr-only">Maximum wind </span>
              {Math.round(day.windKph)} km/h
            </p>
          )}
        </section>
      ))}
    </div>
  )
}

export function WeatherCard(props: AnswerProps<"Weather">) {
  const count = props.days.length
  const single = count === 1
  const current =
    props.current ??
    (props.temperature !== undefined &&
    props.condition &&
    props.windKph !== undefined
      ? {
          temperature: props.temperature,
          condition: props.condition,
          windKph: props.windKph,
          at: undefined,
          feelsLike: undefined,
        }
      : undefined)
  return (
    <div
      className="@container min-w-0"
      data-weather-layout={
        single ? "day" : count === 2 ? "comparison" : "overview"
      }
    >
      <ResultCard
        title={props.location}
        description={`${single ? "Daily forecast" : `${count}-day forecast`} · Local time in ${props.timezone}`}
        provenance={{
          ...props,
          asOf: updatedLabel(props.asOf, props.timezone),
        }}
      >
        <div className="flex min-w-0 flex-col gap-6">
          {current && (
            <div
              className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b pb-4 text-sm"
              aria-label="Current conditions"
            >
              <Badge variant="secondary">
                Now
                {current.at
                  ? ` · ${localTime(current.at, props.timezone, true)}`
                  : ""}
              </Badge>
              <span className="font-medium tabular-nums">
                {Math.round(current.temperature)}°C
              </span>
              <span className="text-muted-foreground">{current.condition}</span>
              {current.feelsLike !== undefined && (
                <span className="text-muted-foreground">
                  Feels like {Math.round(current.feelsLike)}°
                </span>
              )}
              <span className="text-muted-foreground">
                Wind {Math.round(current.windKph)} km/h
              </span>
            </div>
          )}
          {count <= 2 ? (
            <div
              className={cn(
                "grid min-w-0 gap-6",
                count === 2 && "@md:grid-cols-2"
              )}
            >
              {props.days.map((day) => (
                <DetailedDay
                  key={day.date}
                  day={day}
                  timezone={props.timezone}
                  single={single}
                />
              ))}
            </div>
          ) : (
            <ForecastOverview days={props.days} />
          )}
        </div>
      </ResultCard>
    </div>
  )
}
