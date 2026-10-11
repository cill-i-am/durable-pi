/** Coordinate native session reads with cookie rotation, without storing credentials. */
export function sessionFetch(fetcher: typeof fetch): typeof fetch {
  let rotation: Promise<void> | undefined
  const reads = new Set<Promise<Response>>()
  return async (input, init) => {
    const path = new URL(
      input instanceof Request ? input.url : String(input),
      "http://local"
    ).pathname
    if (path === "/api/auth/get-session") {
      // Include polls, focus, reconnect and cross-tab notifications from Better Auth.
      while (rotation) await rotation
      const read = fetcher(input, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      })
      reads.add(read)
      try {
        return await read
      } finally {
        reads.delete(read)
      }
    }
    if (
      [
        "/api/auth/two-factor/enable",
        "/api/auth/two-factor/verify-totp",
        "/api/auth/two-factor/disable",
      ].includes(path)
    ) {
      const previous = rotation
      let release!: () => void
      const current = new Promise<void>((resolve) => {
        release = resolve
      })
      rotation = current
      try {
        if (previous) await previous
        await Promise.allSettled([...reads])
        // Resolving fetch means the browser has installed the response's Set-Cookie.
        return await fetcher(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000),
        })
      } finally {
        if (rotation === current) rotation = undefined
        release()
      }
    }
    return fetcher(input, init)
  }
}
