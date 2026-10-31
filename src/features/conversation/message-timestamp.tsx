/** Historical snapshots may predate reply times; label the request time honestly. */
export function MessageTimestamp({
  at,
  startedAt,
}: {
  at?: string
  startedAt?: string
}) {
  const value = at ?? startedAt
  const date = value ? new Date(value) : null
  if (!date || !Number.isFinite(date.getTime()))
    return <span className="message-timestamp">Time unavailable</span>
  return (
    <time
      className="message-timestamp"
      dateTime={date.toISOString()}
      title={`${at ? "" : "Started "}${date.toLocaleString()}`}
    >
      {!at && "Started "}
      {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
    </time>
  )
}
