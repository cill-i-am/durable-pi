import { Check, CircleAlert, Copy } from "lucide-react"
import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react"

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
  children,
  variant = "ghost",
  size = "icon-xs",
}: {
  text: string
  label: string
  className?: string
  children?: ReactNode
  variant?: ComponentProps<typeof Button>["variant"]
  size?: ComponentProps<typeof Button>["size"]
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
              variant={variant}
              size={size}
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
          {children}
        </TooltipTrigger>
        <TooltipContent>{description}</TooltipContent>
      </Tooltip>
      <span className="sr-only" role="status">
        {status === "ready" ? "" : description}
      </span>
    </>
  )
}
