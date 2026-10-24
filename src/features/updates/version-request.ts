/** Include response-body release in the version check's owned promise. Even an
 * unsuccessful HTTP response may have a live body when its headers arrive. */
export async function requestRevision(signal: AbortSignal, fetcher = fetch) {
  const response = await fetcher("/api/version", {
    cache: "no-store",
    credentials: "omit",
    signal,
  })
  if (!response.ok) {
    await response.body?.cancel()
    return null
  }
  const value: unknown = await response.json()
  return value && typeof value === "object" && "revision" in value
    ? value.revision
    : null
}
