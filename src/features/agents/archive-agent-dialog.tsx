import { useRef, useState } from "react"
import type { AgentProfile } from "@/agents/contracts"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

export function ArchiveAgentDialog({
  agent,
  onConfirm,
  onClose,
}: {
  agent: AgentProfile
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const cancel = useRef<HTMLButtonElement>(null)
  const submitting = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")

  async function confirm() {
    if (submitting.current) return
    submitting.current = true
    setPending(true)
    setError("")
    try {
      await onConfirm()
      onClose()
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not archive this agent."
      )
    } finally {
      submitting.current = false
      setPending(false)
    }
  }

  return (
    <AlertDialog
      open
      dismissible={!pending}
      onOpenChange={(open) => {
        if (!open && !submitting.current) onClose()
      }}
    >
      <AlertDialogContent
        initialFocus={cancel}
        className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto"
        aria-busy={pending}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">
            Archive {agent.name}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This agent will move to Archived agents. Its conversations and saved
            work will be kept. You can restore it later from the account menu.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancel} disabled={pending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={() => void confirm()}>
            {pending ? "Archiving…" : "Archive agent"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
