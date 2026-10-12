import { useEffect, useRef, useState } from "react"
import { Check, CircleAlert, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useInteractionSound } from "@/hooks/use-interaction-sound"

export function CopyButton({
  text,
  label,
  className,
}: {
  text: string
  label: string
  className?: string
}) {
  const [feedback, setFeedback] = useState<{
    text: string
    status: "copied" | "failed"
  } | null>(null)
  const attempt = useRef(0)
  const playInteractionSound = useInteractionSound()
  const status = feedback?.text === text ? feedback.status : "ready"
  const description =
    status === "copied"
      ? "Copied"
      : status === "failed"
        ? "Copy failed. Try again"
        : label

  useEffect(() => {
    if (feedback?.status !== "copied") return
    const timeout = window.setTimeout(() => setFeedback(null), 2000)
    return () => window.clearTimeout(timeout)
  }, [feedback])

  const copy = async () => {
    const currentAttempt = ++attempt.current
    void playInteractionSound()
    try {
      await navigator.clipboard.writeText(text)
      if (currentAttempt === attempt.current) {
        setFeedback({ text, status: "copied" })
      }
    } catch {
      if (currentAttempt === attempt.current) {
        setFeedback({ text, status: "failed" })
      }
    }
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className={className}
              aria-label={description}
              onClick={() => void copy()}
            />
          }
        >
          {status === "copied" ? (
            <Check />
          ) : status === "failed" ? (
            <CircleAlert />
          ) : (
            <Copy />
          )}
        </TooltipTrigger>
        <TooltipContent>{description}</TooltipContent>
      </Tooltip>
      <span className="sr-only" role="status">
        {status === "ready" ? "" : description}
      </span>
    </>
  )
}
