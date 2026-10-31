import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { useRef } from "react"

import type { AgentProfile } from "@/agents/contracts"
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

import "./assistant-management.css"

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
        className="assistant-archive-dialog"
        aria-busy={pending}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">
            Archive {agent.name}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Its conversations and saved work will be kept. You can restore it
            from Archived assistants.
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
            {pending ? "Archiving…" : "Archive assistant"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
