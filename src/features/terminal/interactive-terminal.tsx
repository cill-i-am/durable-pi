import { useEffect, useRef, useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { agentUrl } from "@/http/client"
import type { InteractiveState } from "@/terminal/contracts"

import type { LeaseState } from "./session-lease"

import "@xterm/xterm/css/xterm.css"

type Session = typeof InteractiveState.Type
export function InteractiveTerminal({
  agentId,
  session,
  lease,
  busy,
  attempt,
  onStart,
  onSave,
  onDiscard,
}: {
  agentId: string
  session: Session | null
  lease: LeaseState
  busy: boolean
  attempt: boolean
  onStart: () => void
  onSave: () => void
  onDiscard: () => void
}) {
  return (
    <section aria-label="Interactive terminal" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Interactive shell</h3>
        <Badge variant="secondary">{session?.phase ?? "Closed"}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        Only this shell can use the workspace until you close it. Save before
        leaving to retain changes in /workspace. Discard keeps the previous
        checkpoint.
      </p>
      {lease.error && (
        <Alert>
          <AlertDescription>{lease.error}</AlertDescription>
        </Alert>
      )}
      {!session ? (
        <Button size="sm" disabled={busy && !attempt} onClick={onStart}>
          {attempt ? "Retry opening same session" : "Open interactive terminal"}
        </Button>
      ) : (
        <>
          {session.phase === "ready" ? (
            <LiveTerminal
              key={session.id}
              agentId={agentId}
              session={session}
              ended={lease.ended}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {session.phase === "starting"
                ? "Preparing your saved workspace…"
                : "Saving workspace and stopping the container…"}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || lease.ended || session.phase !== "ready"}
              onClick={onSave}
            >
              Save and close
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || session.phase === "saving"}
              onClick={onDiscard}
            >
              Discard and stop
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Ends by {new Date(session.maximumAt).toLocaleTimeString()}. Closing
            this panel, losing sign-in, or being offline for 30 seconds stops
            the session without saving. Terminal input/output is not added to
            the conversation.
          </p>
        </>
      )}
    </section>
  )
}
function LiveTerminal({
  agentId,
  session,
  ended,
}: {
  agentId: string
  session: Session
  ended: boolean
}) {
  const host = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState("Connecting")
  const [error, setError] = useState("")
  useEffect(() => {
    const element = host.current
    if (!element || ended) return
    let disposed = false
    let destroy = () => {}
    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@cloudflare/sandbox-v0/xterm"),
    ])
      .then(([{ Terminal }, { FitAddon }, { SandboxAddon }]) => {
        if (disposed) return
        const style = getComputedStyle(element)
        const terminal = new Terminal({
          cursorBlink: true,
          fontSize: 12,
          scrollback: 1000,
          screenReaderMode: true,
          windowOptions: {},
          theme: { background: style.backgroundColor, foreground: style.color },
          fontFamily: style.fontFamily,
        })
        const fit = new FitAddon()
        const addon = new SandboxAddon({
          reconnect: true,
          getWebSocketUrl: ({ origin }) =>
            origin +
            agentUrl(
              agentId,
              `terminal/session/${encodeURIComponent(session.id)}/socket`
            ),
          onStateChange: (state) => {
            if (!disposed)
              setStatus(
                state === "connected"
                  ? "Connected"
                  : state === "connecting"
                    ? "Connecting"
                    : "Disconnected"
              )
          },
        })
        terminal.loadAddon(fit)
        terminal.loadAddon(addon)
        terminal.open(element)
        const resize = () => {
          if (element.clientWidth > 0 && element.clientHeight > 0) fit.fit()
        }
        resize()
        const observer = new ResizeObserver(resize)
        observer.observe(element)
        addon.connect({ sandboxId: session.id })
        destroy = () => {
          observer.disconnect()
          addon.disconnect()
          terminal.dispose()
        }
      })
      .catch(() => {
        if (!disposed)
          setError("Could not load the terminal. Close and reopen this panel.")
      })
    return () => {
      disposed = true
      destroy()
    }
  }, [agentId, session.id, ended])
  return (
    <>
      {error && (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <p className="text-xs text-muted-foreground" role="status">
        {ended ? "Disconnected" : status}
      </p>
      <div
        ref={host}
        data-base-ui-swipe-ignore=""
        className="terminal-surface h-72 min-w-0 overflow-hidden rounded-md border p-2"
        aria-label="Live Linux terminal"
      />
    </>
  )
}
