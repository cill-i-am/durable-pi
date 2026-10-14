import { ApiError } from "@/http/client"

export type LeaseState = { ended: boolean; error: string }
export function maintainSessionLease(
  initialExpiry: number,
  renew: (signal: AbortSignal) => Promise<{ expiresAt: number }>,
  changed: (state: LeaseState) => void
) {
  const controller = new AbortController()
  let expiresAt = initialExpiry
  let timer: ReturnType<typeof setTimeout> | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    clearTimeout(timer)
    clearTimeout(expiry)
    controller.abort()
  }
  const end = (error: string) => {
    stop()
    changed({ ended: true, error })
  }
  const armExpiry = () => {
    clearTimeout(expiry)
    expiry = setTimeout(
      () =>
        end(
          "The terminal lease expired. Unsaved changes were discarded. Open a new session to continue."
        ),
      Math.max(0, expiresAt - Date.now())
    )
  }
  const update = async () => {
    try {
      const result = await renew(controller.signal)
      if (controller.signal.aborted) return
      expiresAt = result.expiresAt
      changed({ ended: false, error: "" })
      armExpiry()
      timer = setTimeout(() => void update(), 10_000)
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && [401, 403, 409].includes(cause.status)) {
        end(
          cause.status === 401
            ? "Sign-in expired. The terminal will stop without saving. Sign in again to continue."
            : "This terminal session has ended. Check its result before reopening."
        )
        return
      }
      changed({
        ended: false,
        error:
          "Connection interrupted. Retrying within the current terminal lease…",
      })
      timer = setTimeout(() => void update(), 2000)
    }
  }
  armExpiry()
  void update()
  return stop
}
