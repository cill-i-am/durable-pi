import { AgentAvatar } from "@workspace/ui/components/agent-avatar"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Textarea } from "@workspace/ui/components/textarea"

import type { AgentProfile } from "@/agents/contracts"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"

import { useAgentEditor } from "./use-agent-editor"

import "./assistant-management.css"

export { useAgentCatalog } from "./use-agent-catalog"

export function AgentEditor({
  agent,
  open,
  onOpenChange,
  onSaved,
}: {
  agent?: AgentProfile
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (agent: AgentProfile, signal?: AbortSignal) => Promise<void>
}) {
  const editor = useAgentEditor(agent, onSaved, () => onOpenChange(false))
  const { name, instructions } = editor.draft
  const { error, pending } = editor
  function save(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    editor.save()
  }
  return (
    <Sheet
      open={open}
      dismissible={!pending}
      onOpenChange={(value) => {
        if (!value) editor.dismiss()
      }}
    >
      <SheetContent className="assistant-editor-sheet">
        <SheetHeader>
          <SheetTitle>
            {editor.existing ? "Edit assistant" : "New assistant"}
          </SheetTitle>
          <SheetDescription>
            Choose a name and what it should help with.
          </SheetDescription>
        </SheetHeader>
        <form
          className="assistant-editor-form"
          onSubmit={save}
          aria-busy={pending}
        >
          <div className="assistant-editor-preview">
            <AgentAvatar
              name={editor.id}
              label={name || "New assistant"}
              aria-hidden="true"
            />
            <span>{name || "New assistant"}</span>
          </div>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="agent-name">Name</FieldLabel>
              <Input
                id="agent-name"
                disabled={!editor.ready}
                value={name}
                onChange={(e) => editor.change("name", e.target.value)}
                placeholder="Research, Studio, Home…"
                maxLength={80}
                required
                pattern=".*\S.*"
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="agent-instructions">Purpose</FieldLabel>
              <Textarea
                id="agent-instructions"
                disabled={!editor.ready}
                value={instructions}
                onChange={(e) => editor.change("instructions", e.target.value)}
                placeholder="What should this assistant help with?"
                rows={4}
                maxLength={8000}
              />
              <FieldDescription>Changes apply to new turns.</FieldDescription>
            </Field>
            {error && (
              <Alert role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="assistant-editor-actions">
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={editor.dismiss}
              >
                Cancel
              </Button>
              {editor.refreshFailed ? (
                <Button type="button" onClick={editor.reconcile}>
                  Refresh assistant list
                </Button>
              ) : (
                <Button type="submit" disabled={pending}>
                  {pending
                    ? "Saving…"
                    : editor.existing
                      ? "Save changes"
                      : "Create assistant"}
                </Button>
              )}
            </div>
          </FieldGroup>
        </form>
      </SheetContent>
    </Sheet>
  )
}
