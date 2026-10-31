import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { createEffectActor, send } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber, Semaphore } from "effect"
import { useEffect, useRef, useState } from "react"

import { agentUrl } from "@/http/client"
import { nativeOperation } from "@/shared/interop"
import type { InteractiveState } from "@/terminal/contracts"

import { interactiveHostMachine } from "./interactive-host.machine"
import { terminalWorkFailures } from "./owned-work"
import type { LeaseState } from "./session-lease"

import "@xterm/xterm/css/xterm.css"

const hostPermit = Effect.runSync(Semaphore.make(1))

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
            this tab, switching assistants, losing sign-in, or being offline for
            30 seconds stops the session without saving. Hiding the workbench
            keeps this session open. Terminal input/output is not added to the
            conversation.
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
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const observe = yield* terminalWorkFailures
        let notifyReady = () => {}
        const work = hostPermit.withPermit(
          Effect.gen(function* () {
            const [{ Terminal }, { FitAddon }, { NativeTerminalAddon }] =
              yield* nativeOperation(
                () =>
                  Promise.all([
                    import("@xterm/xterm"),
                    import("@xterm/addon-fit"),
                    import("./native-terminal-addon"),
                  ]),
                (cause) => cause
              )
            const style = getComputedStyle(element)
            const terminal = yield* Effect.acquireRelease(
              Effect.sync(
                () =>
                  new Terminal({
                    cursorBlink: true,
                    fontSize: 12,
                    scrollback: 1000,
                    screenReaderMode: true,
                    windowOptions: {},
                    theme: {
                      background: style.backgroundColor,
                      foreground: style.color,
                    },
                    fontFamily: style.fontFamily,
                  })
              ),
              (terminal) => Effect.sync(() => terminal.dispose())
            )
            const fit = new FitAddon()
            const addon = yield* Effect.acquireRelease(
              Effect.sync(
                () =>
                  new NativeTerminalAddon(
                    () =>
                      location.origin +
                      agentUrl(
                        agentId,
                        "terminal/session/" +
                          encodeURIComponent(session.id) +
                          "/socket"
                      ),
                    (state) => {
                      if (mounted)
                        setStatus(
                          state === "connected"
                            ? "Connected"
                            : state === "connecting"
                              ? "Connecting"
                              : "Disconnected"
                        )
                    }
                  )
              ),
              (addon) =>
                Effect.promise(() => {
                  addon.dispose()
                  return addon.settled
                }).pipe(
                  Effect.flatMap((exit) =>
                    Exit.isFailure(exit)
                      ? Effect.failCause(exit.cause).pipe(Effect.orDie)
                      : Effect.void
                  )
                )
            )
            terminal.loadAddon(fit)
            terminal.loadAddon(addon)
            terminal.open(element)
            const resize = () => {
              if (element.clientWidth > 0 && element.clientHeight > 0) fit.fit()
            }
            resize()
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                const observer = new ResizeObserver(resize)
                observer.observe(element)
                return observer
              }),
              (observer) => Effect.sync(() => observer.disconnect())
            )
            addon.connect()
            notifyReady()
            return yield* Effect.never
          }).pipe(Effect.scoped)
        )
        const actor = yield* createEffectActor(
          interactiveHostMachine(observe(work))
        )
        notifyReady = () => {
          Effect.runFork(send(actor, { type: "READY" }))
        }
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            actor.subscribe((snapshot) => {
              if (mounted && snapshot.matches("failed"))
                setError(
                  "Could not load the terminal. Close and reopen this panel."
                )
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        return yield* Effect.never
      }).pipe(Effect.scoped)
    )
    return () => {
      mounted = false
      Effect.runFork(
        Fiber.interrupt(fiber).pipe(
          Effect.andThen(Fiber.await(fiber)),
          Effect.flatMap((exit) =>
            Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
              ? Effect.logError(exit.cause)
              : Effect.void
          )
        )
      )
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
