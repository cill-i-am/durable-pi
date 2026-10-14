export function poll(
  refresh: () => Promise<void>,
  delay = 2000,
  immediate = false
) {
  let stopped = false
  let timer: ReturnType<typeof setTimeout>
  const next = () => {
    timer = setTimeout(async () => {
      try {
        await refresh()
      } finally {
        if (!stopped) next()
      }
    }, delay)
  }
  if (immediate)
    void refresh().finally(() => {
      if (!stopped) next()
    })
  else next()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
