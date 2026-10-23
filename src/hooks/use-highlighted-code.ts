import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import * as React from "react"
import type { SnapshotFrom } from "xstate"

import { highlightedCodeMachine } from "./highlighted-code.machine"

type HighlightMachine = ReturnType<typeof highlightedCodeMachine>

export function useHighlightedCode(value: string, language: string) {
  // A trailing newline would render as an extra empty line.
  const code = value.endsWith("\n") ? value.slice(0, -1) : value
  const [actor, setActor] =
    React.useState<EffectActor<HighlightMachine> | null>(null)
  const [snapshot, setSnapshot] =
    React.useState<SnapshotFrom<HighlightMachine> | null>(null)
  React.useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const owned = yield* createEffectActor(
          highlightedCodeMachine((language) =>
            Effect.tryPromise({
              try: () =>
                import("@/lib/highlighter").then((module) =>
                  module.loadHighlighter(language)
                ),
              catch: (cause) => cause,
            })
          ),
          { input: { language } }
        )
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            owned.subscribe((value) => {
              if (mounted) setSnapshot(value)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        if (mounted) {
          setActor(owned)
          setSnapshot(owned.getSnapshot())
        }
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
    // Language changes replace the actor's invocation, not its React owner.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [])
  React.useEffect(() => {
    if (actor) Effect.runFork(send(actor, { type: "LANGUAGE", language }))
  }, [actor, language])
  // React can render the next language before its event reaches the mailbox.
  const highlighter =
    snapshot?.context.language === language
      ? snapshot.context.highlighter
      : null

  // The complete lines, highlighted. While the code streams, only the new
  // lines are tokenized, starting from the grammar state of the last one.
  const [done, setDone] = React.useState<{
    highlighter: typeof highlighter
    text: string
    lines: React.ReactNode[]
    state?: Parameters<NonNullable<typeof highlighter>["highlight"]>[1]
  }>({ highlighter: null, text: "", lines: [] })

  let next = done

  if (next.highlighter !== highlighter || !code.startsWith(next.text)) {
    next = { highlighter, text: "", lines: [] }
  }

  const end = code.lastIndexOf("\n") + 1

  if (highlighter && end > next.text.length) {
    const result = highlighter.highlight(
      code.slice(next.text.length, end - 1),
      next.state
    )

    next = {
      highlighter,
      text: code.slice(0, end),
      lines: [...next.lines, ...result.lines],
      state: result.state,
    }
  }

  if (next !== done) {
    setDone(next)
  }

  // The last line is still being written, so it is tokenized on every render.
  const tail = code.slice(end)

  return React.useMemo(() => {
    if (!highlighter) {
      return code.split("\n")
    }

    return [...next.lines, highlighter.highlight(tail, next.state).lines[0]]
  }, [code, highlighter, next, tail])
}
