import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Tabs, TabsList, TabsTrigger } from "@workspace/ui/components/tabs"
import { Textarea } from "@workspace/ui/components/textarea"
import { Plus, Upload, X, ArrowUpRight } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Markdown } from "@/components/markdown"
import { SettingsSection } from "@/components/settings-section"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import type { SaveSkill, Skill } from "@/skills/contracts"

import { HostedSkillImport, SkillSourceLabel } from "./hosted-skill-import"
import { useSkillView } from "./use-skill-view"
import { useSkills, type SkillsState } from "./use-skills"

type SkillsPanelProps = {
  embedded?: boolean
  onPendingChange?: (pending: boolean) => void
  agentId?: string
  agentName?: string
  onManageLibrary?: () => void
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SkillsPanel({ agentId, ...props }: SkillsPanelProps) {
  return agentId ? (
    <AssignedSkillsPanel key={agentId} {...props} agentId={agentId} />
  ) : (
    <SkillLibraryPanel {...props} />
  )
}

function SkillLibraryPanel({
  embedded = false,
  onPendingChange,
  open,
  onOpenChange: setOpen,
}: SkillsPanelProps) {
  const state = useSkills()
  const { refresh } = state
  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])
  const [tab, setTab] = useState("library")
  const showArchived = tab === "archived"
  const view = useSkillView()
  const { draft, history, historyBusy, importing, hosted: hostedImport } = view
  const input = useRef<HTMLInputElement>(null)
  const setDraft = (value: SaveSkill | null) => {
    if (!value) view.event({ type: "CANCEL" })
    else if (draft) view.setFields(value)
    else view.event({ type: "EDIT", draft: value })
  }
  const cannotReplace =
    state.busy ||
    !state.ready ||
    state.loading ||
    !!draft ||
    importing ||
    hostedImport
  const leaveView = () => view.event({ type: "LEAVE" })
  const newSkill = () =>
    view.event({
      type: "EDIT",
      draft: {
        id: crypto.randomUUID(),
        expectedRevision: 0,
        name: "",
        body: "",
      },
    })
  const versions = (skill: Skill) => view.event({ type: "HISTORY", skill })
  const editing = draft !== null
  useEffect(() => {
    onPendingChange?.(state.busy || editing || importing || hostedImport)
  }, [state.busy, editing, importing, hostedImport, onPendingChange])
  return (
    <SettingsSection
      embedded={embedded}
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (!value) leaveView()
      }}
      title="Skills"
      description="Reusable instructions for your assistants."
    >
      <div className="settings-toolbar">
        <Tabs
          value={tab}
          onValueChange={(value) => {
            leaveView()
            setTab(String(value))
          }}
        >
          <TabsList>
            <TabsTrigger value="library" disabled={cannotReplace}>
              Library
            </TabsTrigger>
            <TabsTrigger value="archived" disabled={cannotReplace}>
              Archived
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button size="sm" variant="ghost" disabled={cannotReplace} />
              }
            >
              <Upload />
              <span className="sr-only sm:not-sr-only">Import</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => input.current?.click()}>
                Markdown file
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  leaveView()
                  view.event({ type: "HOSTED" })
                }}
              >
                From Executor
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" disabled={cannotReplace} onClick={newSkill}>
            <Plus />
            New
          </Button>
        </div>
        <input
          ref={input}
          type="file"
          accept=".md,.txt,text/plain,text/markdown"
          hidden
          tabIndex={-1}
          aria-label="Import skill Markdown"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ""
            if (file && !cannotReplace)
              view.event({ type: "FILE", file, id: crypto.randomUUID() })
          }}
        />
      </div>
      <div className="settings-panel-body">
        <SkillProblem state={state} view={view} />
        {state.loading && (
          <p className="text-sm text-muted-foreground">Loading skills…</p>
        )}
        {hostedImport ? (
          <HostedSkillImport
            onCancel={() => view.event({ type: "CANCEL" })}
            onPreview={(value) => {
              view.event({ type: "EDIT", draft: value })
            }}
          />
        ) : draft ? (
          <SkillEditor
            state={state}
            draft={draft}
            setDraft={setDraft}
            onSaved={() =>
              view.event({ type: "SAVED", generation: view.generation })
            }
          />
        ) : history ? (
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">{history.skill.name} · history</h3>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => view.event({ type: "CANCEL" })}
              >
                Back to library
              </Button>
            </div>
            {history.versions.map((version) => (
              <details key={version.revision} className="rounded-md border p-3">
                <summary className="cursor-pointer text-sm">
                  v{version.revision} ·{" "}
                  {new Date(version.createdAt).toLocaleDateString()}
                </summary>
                <div className="prose prose-sm mt-3 max-w-none break-words">
                  <Markdown text={version.body} />
                </div>
                <SkillSourceLabel source={version.source} />
                {!history.skill.archived &&
                  version.revision !== history.skill.revision && (
                    <Button
                      size="xs"
                      variant="outline"
                      className="mt-3"
                      disabled={state.busy}
                      onClick={() => {
                        setDraft({
                          id: version.id,
                          expectedRevision: history.skill.revision,
                          name: version.name,
                          body: version.body,
                          source: version.source,
                        })
                      }}
                    >
                      Restore as a new revision
                    </Button>
                  )}
              </details>
            ))}
          </section>
        ) : (
          <div className="divide-y">
            {state.library
              .filter((skill) => skill.archived === showArchived)
              .map((skill) => (
                <SkillRow
                  key={skill.id}
                  skill={skill}
                  state={state}
                  assignment={false}
                  historyBusy={historyBusy || importing}
                  onEdit={() => {
                    leaveView()
                    setDraft({
                      id: skill.id,
                      expectedRevision: skill.revision,
                      name: skill.name,
                      body: skill.body,
                      source: skill.source,
                    })
                  }}
                  onHistory={() => void versions(skill)}
                />
              ))}
            {state.ready &&
              !state.library.some(
                (skill) => skill.archived === showArchived
              ) && (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {showArchived
                    ? "No archived skills."
                    : "No skills yet. Create a skill or import instructions."}
                </p>
              )}
          </div>
        )}
      </div>
      <p className="settings-panel-footer">
        Editing or archiving a library skill leaves pinned assistant revisions
        intact.
      </p>
    </SettingsSection>
  )
}
function AssignedSkillsPanel({
  embedded = false,
  onPendingChange,
  agentId,
  agentName = "this assistant",
  onManageLibrary,
  open,
  onOpenChange,
}: SkillsPanelProps & { agentId: string }) {
  const state = useSkills(agentId)
  const { refresh } = state
  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])
  useEffect(() => {
    onPendingChange?.(state.busy)
  }, [state.busy, onPendingChange])
  return (
    <SettingsSection
      embedded={embedded}
      open={open}
      onOpenChange={onOpenChange}
      title="Skills"
      description={<>Choose the revisions {agentName} uses.</>}
    >
      {onManageLibrary && (
        <div className="settings-toolbar">
          <Button
            size="sm"
            variant="ghost"
            disabled={state.busy || !state.ready || state.loading}
            onClick={onManageLibrary}
          >
            Manage library
          </Button>
        </div>
      )}
      <div className="settings-panel-body">
        {state.error && (
          <Alert>
            <AlertDescription>
              {state.error}
              {state.failed && (
                <Button
                  size="xs"
                  variant="link"
                  disabled={state.busy}
                  onClick={() => void state.retry()}
                >
                  Retry same change
                </Button>
              )}
              <Button
                size="xs"
                variant="link"
                disabled={state.busy}
                onClick={() => void refresh()}
              >
                Reload
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {state.loading && (
          <p className="text-sm text-muted-foreground">Loading skills…</p>
        )}
        <section aria-label="Selected skills" className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            For {agentName ?? "this assistant"} ·{" "}
            {state.selection.skills.length}/4
          </h3>
          {!state.selection.skills.length && (
            <p className="text-sm text-muted-foreground">
              Choose skills below to guide new replies.
            </p>
          )}
          {state.selection.skills.map((skill) => {
            const latest = state.library.find((item) => item.id === skill.id)
            return (
              <div key={skill.id} className="settings-selected-skill">
                <span className="min-w-0 flex-1 truncate text-sm">
                  {skill.name}{" "}
                  <span className="text-muted-foreground">
                    v{skill.revision}
                    {latest?.archived ? " · archived" : ""}
                  </span>
                </span>
                {latest &&
                  !latest.archived &&
                  latest.revision > skill.revision && (
                    <Button
                      aria-label={`Update ${skill.name} to version ${latest.revision}`}
                      size="xs"
                      variant="ghost"
                      disabled={state.busy || !state.ready}
                      onClick={() =>
                        void state.select(
                          state.selection.skills.map((value) => ({
                            id: value.id,
                            revision:
                              value.id === skill.id
                                ? latest.revision
                                : value.revision,
                          }))
                        )
                      }
                    >
                      <ArrowUpRight />v{latest.revision}
                    </Button>
                  )}
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={state.busy || !state.ready}
                  aria-label={`Remove ${skill.name} from this assistant`}
                  onClick={() =>
                    void state.select(
                      state.selection.skills
                        .filter((value) => value.id !== skill.id)
                        .map(({ id, revision }) => ({ id, revision }))
                    )
                  }
                >
                  <X />
                </Button>
              </div>
            )
          })}
        </section>

        <div className="divide-y">
          {state.library
            .filter((skill) => !skill.archived)
            .map((skill) => (
              <SkillRow key={skill.id} skill={skill} state={state} assignment />
            ))}
          {state.ready && !state.library.some((skill) => !skill.archived) && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No active skills in the library.
            </p>
          )}
        </div>
      </div>
      <p className="settings-panel-footer">
        Skills apply to new replies. They never grant tool access.
      </p>
    </SettingsSection>
  )
}

function SkillProblem({
  state,
  view,
}: {
  state: SkillsState
  view: ReturnType<typeof useSkillView>
}) {
  const { error: localError, draft } = view
  if (!state.error && !localError && !state.failed) return null
  return (
    <Alert>
      <AlertDescription>
        {localError ||
          state.error ||
          "The previous update was not confirmed. Review the saved state before retrying."}
        {state.failed && (
          <Button
            size="xs"
            variant="link"
            disabled={state.busy}
            onClick={() => {
              const failed = state.failed
              const generation = view.generation
              const sameDraft =
                failed?.kind === "save" &&
                draft &&
                JSON.stringify(failed.input) ===
                  JSON.stringify({
                    ...draft,
                    name: draft.name.trim(),
                    body: draft.body.trim(),
                  })
              void state.retry().then((result) => {
                if (result && sameDraft)
                  view.event({ type: "SAVED", generation })
              })
            }}
          >
            Retry same change
          </Button>
        )}
        <Button
          size="xs"
          variant="link"
          disabled={state.busy}
          onClick={() => {
            view.event({ type: "CLEAR_ERROR" })
            void state.refresh()
          }}
        >
          Reload
        </Button>
      </AlertDescription>
    </Alert>
  )
}

function SkillRow({
  skill,
  state,
  assignment,
  historyBusy = false,
  onEdit,
  onHistory,
}: {
  skill: Skill
  state: SkillsState
  assignment: boolean
  historyBusy?: boolean
  onEdit?: () => void
  onHistory?: () => void
}) {
  const selected = state.selection.skills.some((value) => value.id === skill.id)
  return (
    <article className="settings-skill-row">
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate font-medium">{skill.name}</h3>
        <span className="text-xs text-muted-foreground">v{skill.revision}</span>
      </div>
      <p className="line-clamp-2 text-sm text-muted-foreground">{skill.body}</p>
      <SkillSourceLabel source={skill.source} />
      <div className="flex flex-wrap justify-end gap-1">
        {!assignment && (
          <Button
            size="xs"
            variant="ghost"
            disabled={state.busy || historyBusy}
            onClick={onHistory}
          >
            History
          </Button>
        )}
        {!skill.archived && (
          <>
            {!assignment && (
              <Button
                size="xs"
                variant="ghost"
                disabled={state.busy}
                onClick={onEdit}
              >
                Edit
              </Button>
            )}
            {assignment && (
              <Button
                size="xs"
                variant="outline"
                disabled={
                  state.busy ||
                  !state.ready ||
                  selected ||
                  state.selection.skills.length >= 4
                }
                onClick={() =>
                  void state.select([
                    ...state.selection.skills.map(({ id, revision }) => ({
                      id,
                      revision,
                    })),
                    { id: skill.id, revision: skill.revision },
                  ])
                }
              >
                {selected ? "Selected" : "Use for this assistant"}
              </Button>
            )}
          </>
        )}
        {!assignment && (
          <Button
            size="xs"
            variant="ghost"
            disabled={state.busy}
            onClick={() => void state.archive(skill)}
          >
            {skill.archived ? "Restore" : "Archive"}
          </Button>
        )}
      </div>
    </article>
  )
}

function SkillEditor({
  state,
  draft,
  setDraft,
  onSaved,
}: {
  onSaved: () => void
  state: ReturnType<typeof useSkills>
  draft: SaveSkill
  setDraft: (draft: SaveSkill | null) => void
}) {
  const currentDraft = draft
    ? state.library.find((skill) => skill.id === draft.id)
    : undefined
  const conflict =
    !!draft &&
    !!currentDraft &&
    currentDraft.revision !== draft.expectedRevision
  return (
    <form
      className="settings-form"
      onSubmit={async (event) => {
        event.preventDefault()
        const saved = await state.save({
          ...draft,
          name: draft.name.trim(),
          body: draft.body.trim(),
        })
        if (saved) onSaved()
      }}
    >
      <h3 className="font-medium">
        {draft.expectedRevision ? "Edit skill" : "New skill"}
      </h3>
      <SkillSourceLabel source={draft.source} />
      {conflict && (
        <Alert>
          <AlertDescription>
            <p>
              A newer revision (v{currentDraft.revision}) is saved. Your draft
              is preserved below. Review the saved version before continuing.
            </p>
            <details className="my-2">
              <summary className="cursor-pointer">
                View saved instructions
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto text-xs whitespace-pre-wrap">
                {currentDraft.body}
              </pre>
            </details>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={state.busy || state.loading}
                onClick={() =>
                  setDraft({
                    ...draft,
                    expectedRevision: currentDraft.revision,
                  })
                }
              >
                Keep my draft
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={state.busy || state.loading}
                onClick={() =>
                  setDraft({
                    id: currentDraft.id,
                    expectedRevision: currentDraft.revision,
                    name: currentDraft.name,
                    body: currentDraft.body,
                    source: currentDraft.source,
                  })
                }
              >
                Use saved version
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      {currentDraft?.archived && (
        <p className="text-sm text-destructive">
          This skill is archived. Cancel editing and restore it from Archived
          first.
        </p>
      )}
      <Field>
        <FieldLabel htmlFor="skill-name">Name</FieldLabel>
        <Input
          id="skill-name"
          autoFocus
          value={draft.name}
          maxLength={80}
          required
          disabled={state.busy}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="skill-body">Instructions</FieldLabel>
        <Textarea
          id="skill-body"
          className="min-h-56 font-mono text-sm"
          value={draft.body}
          maxLength={16_000}
          required
          disabled={state.busy}
          onChange={(event) => setDraft({ ...draft, body: event.target.value })}
        />
      </Field>
      <p className="text-xs text-muted-foreground">
        {draft.body.length.toLocaleString()}/16,000 characters. Keep secrets out
        of skills. Saving creates a revision; bots stay on their selected
        versions.
      </p>
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={
            state.busy || !state.ready || conflict || currentDraft?.archived
          }
        >
          {state.busy ? "Saving…" : "Save skill"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={state.busy}
          onClick={() => setDraft(null)}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
