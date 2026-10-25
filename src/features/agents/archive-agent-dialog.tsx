import { useRef } from "react"

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
  pending,
  error,
}: {
  agent: AgentProfile
  onConfirm: () => void
  onClose: () => void
  pending: boolean
  error: string
}) {
  const cancel = useRef<HTMLButtonElement>(null)
  return (
    <AlertDialog
      open
      dismissible={!pending}
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
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
          <AlertDialogAction disabled={pending} onClick={onConfirm}>
            {pending ? "Archiving…" : "Archive agent"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
