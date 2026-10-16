export function sessionFetch(fetcher: typeof fetch): typeof fetch {
  let rotation: Promise<void> | undefined
  const reads = new Map<string, Promise<Response>>()
  let limitedUntil = 0

  return async (input, init) => {
    const { url, method, callerSignal } = fetchRequest(input, init)
    if (url.pathname === "/api/auth/get-session" && method === "GET") {
      while (rotation) await abortable(rotation, callerSignal)
      callerSignal?.throwIfAborted()
      if (limitedUntil > Date.now())
        return Response.json(
          {
            code: "TOO_MANY_REQUESTS",
            message: "Please wait before checking your session again.",
          },
          {
            status: 429,
            headers: {
              "Retry-After": String(
                Math.ceil((limitedUntil - Date.now()) / 1000)
              ),
            },
          }
        )
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined)
      )
      const key = JSON.stringify([
        url.href,
        [...headers.entries()].sort(),
        init?.credentials ??
          (input instanceof Request ? input.credentials : "same-origin"),
      ])
      let read = reads.get(key)
      if (!read) {
        read = fetcher(input, { ...init, signal: AbortSignal.timeout(15_000) })
          .then((response) => {
            if (response.status === 429) {
              const retry = response.headers.get("Retry-After")
              const seconds =
                retry && /^\d+$/.test(retry)
                  ? Number(retry)
                  : retry
                    ? (Date.parse(retry) - Date.now()) / 1000
                    : 60
              limitedUntil =
                Date.now() +
                Math.max(1, Number.isFinite(seconds) ? seconds : 60) * 1000
            }
            return response
          })
          .finally(() => {
            if (reads.get(key) === read) reads.delete(key)
          })
        reads.set(key, read)
      }
      return (await abortable(read, callerSignal)).clone()
    }
    if (url.pathname.startsWith("/api/auth/") && method !== "GET") {
      const previous = rotation
      let release!: () => void
      const current = new Promise<void>((resolve) => {
        release = resolve
      })
      rotation = current
      try {
        if (previous) await previous
        await Promise.allSettled([...reads.values()])
        const response = await fetcher(input, {
          ...init,
          signal: callerSignal
            ? AbortSignal.any([callerSignal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000),
        })
        limitedUntil = 0
        return response
      } finally {
        if (rotation === current) rotation = undefined
        release()
      }
    }
    return fetcher(input, init)
  }
}

function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal | null
): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort)
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
  })
}

function fetchRequest(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    "http://local"
  )
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase()
  const callerSignal =
    init?.signal ?? (input instanceof Request ? input.signal : undefined)
  return { url, method, callerSignal }
}
