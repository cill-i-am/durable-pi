import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardFrame,
  CardFrameFooter,
} from "@workspace/ui/components/card"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Textarea } from "@workspace/ui/components/textarea"
import type { RefObject } from "react"

import type { AgentProfile } from "@/agents/contracts"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar"

import { useAgentEditor } from "./use-agent-editor"

import "./assistant-management.css"

export { useAgentCatalog } from "./use-agent-catalog"

export function AgentEditor({
  agent,
  pageContainer,
  navigationNotice = false,
  open,
  onOpenChange,
  onSaved,
}: {
  agent?: AgentProfile
  pageContainer: RefObject<HTMLDivElement | null>
  navigationNotice?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (agent: AgentProfile, signal?: AbortSignal) => Promise<void>
}) {
  const editor = useAgentEditor(agent, onSaved, () => onOpenChange(false))
  const { name, instructions } = editor.draft
  const { error, pending } = editor
  const { isMobile } = useSidebar()
  const title = editor.existing ? "Edit assistant" : "New assistant"
  function save(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    editor.save()
  }
  return (
    <Sheet
      desktop="page"
      open={open}
      dismissible={!pending}
      onOpenChange={(value) => {
        if (!value) editor.dismiss()
      }}
    >
      <SheetContent
        className="assistant-editor-sheet"
        portalContainer={pageContainer}
        showCloseButton={isMobile}
        finalFocus={() => document.getElementById("main-content")}
      >
        <SheetHeader className="assistant-editor-header">
          <SidebarTrigger className="assistant-editor-sidebar" />
          <SheetTitle render={<h1>{title}</h1>} />
          <SheetDescription>
            Choose a name and what it should help with.
          </SheetDescription>
        </SheetHeader>
        <div className="assistant-editor-content">
          <form
            className="assistant-editor-form w-full max-w-160"
            onSubmit={save}
            aria-busy={pending}
          >
            <CardFrame>
              <Card>
                <CardContent className="p-6">
                  <FieldGroup>
                    {navigationNotice && (
                      <Alert>
                        <AlertDescription>
                          Finish or cancel the open edit before leaving this
                          view.
                        </AlertDescription>
                      </Alert>
                    )}
                    <Field>
                      <FieldLabel htmlFor="agent-name">Name</FieldLabel>
                      <Input
                        id="agent-name"
                        disabled={!editor.ready}
                        value={name}
                        onChange={(e) => editor.change("name", e.target.value)}
                        placeholder="Travel planner"
                        maxLength={80}
                        required
                        pattern=".*\S.*"
                        autoFocus
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="agent-instructions">
                        Purpose
                      </FieldLabel>
                      <Textarea
                        id="agent-instructions"
                        disabled={!editor.ready}
                        value={instructions}
                        onChange={(e) =>
                          editor.change("instructions", e.target.value)
                        }
                        placeholder="Help us plan family trips, compare options and keep track of the details."
                        rows={4}
                        maxLength={8000}
                      />
                      {editor.existing && (
                        <FieldDescription>
                          Changes apply to new turns.
                        </FieldDescription>
                      )}
                    </Field>
                    {error && (
                      <Alert role="alert">
                        <AlertDescription>{error}</AlertDescription>
                      </Alert>
                    )}
                  </FieldGroup>
                </CardContent>
              </Card>
              <CardFrameFooter variant="actions">
                <Button
                  type="button"
                  variant="outline"
                  className="assistant-editor-cancel"
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
              </CardFrameFooter>
            </CardFrame>
          </form>
        </div>
      </SheetContent>
    </Sheet>
  )
}
