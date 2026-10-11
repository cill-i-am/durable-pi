/** Schedule after completion so a slow response cannot be superseded forever. */
export function pollFiles(refresh: () => Promise<void>, delay = 2000) {
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
  next()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
