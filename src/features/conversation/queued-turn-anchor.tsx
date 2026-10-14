import { useEffect, useLayoutEffect, useRef } from "react"
import type { ChatState } from "@/conversations/contracts"
import {
  useMessageScroller,
  useMessageScrollerScrollable,
} from "@/components/ui/message-scroller"

export function QueuedTurnAnchor({ turns }: { turns: ChatState["turns"] }) {
  const { scrollToMessage } = useMessageScroller()
  const { end } = useMessageScrollerScrollable()
  const previous = useRef({ queued: new Set<string>(), atEnd: false })
  const frame = useRef<number | null>(null)

  useLayoutEffect(() => {
    const before = previous.current
    previous.current = {
      queued: new Set(
        turns.filter((turn) => turn.status === "queued").map((turn) => turn.id)
      ),
      atEnd: !end,
    }
    const started = turns.find(
      (turn) =>
        before.queued.has(turn.id) &&
        ["preparing", "running"].includes(turn.status)
    )
    if (!started || !before.atEnd) return
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      scrollToMessage(`${started.id}:user`, {
        align: "start",
        behavior: "auto",
      })
    })
  }, [turns, end, scrollToMessage])

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    },
    []
  )
  return null
}
