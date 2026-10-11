import { useEffect, useRef, useState } from "react"
import { Plus, Upload, X, ArrowUpRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Markdown } from "@/components/markdown"
import type { SaveSkill, Skill, SkillDocument } from "@/skills/contracts"
import { useSkills, type SkillsState } from "./use-skills"
import { HostedSkillImport, SkillSourceLabel } from "./hosted-skill-import"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"

export function SkillsPanel({
  agentId,
  agentName,
  open,
  onOpenChange: setOpen,
}: {
  agentId: string
  agentName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const state = useSkills(agentId)
  useEffect(() => {
    if (open) void state.refresh()
  }, [open, state.refresh])
  const [tab, setTab] = useState("library")
  const [draft, setDraft] = useState<SaveSkill | null>(null)
  const [history, setHistory] = useState<{
    skill: Skill
    versions: readonly SkillDocument[]
  } | null>(null)
  const [historyBusy, setHistoryBusy] = useState(false)
  const [localError, setLocalError] = useState("")
  const input = useRef<HTMLInputElement>(null)
  const historyRequest = useRef(0)
  const [importing, setImporting] = useState(false)
  const [hostedImport, setHostedImport] = useState(false)
  const currentDraft = draft
    ? state.library.find((skill) => skill.id === draft.id)
    : undefined
  const conflict =
    !!draft &&
    !!currentDraft &&
    currentDraft.revision !== draft.expectedRevision
  const cannotReplace =
    state.busy ||
    !state.ready ||
    state.loading ||
    !!draft ||
    importing ||
    hostedImport
  function leaveView() {
    historyRequest.current++
    setHistoryBusy(false)
    setImporting(false)
    setHostedImport(false)
  }
  function newSkill() {
    leaveView()
    setDraft({
      id: crypto.randomUUID(),
      expectedRevision: 0,
      name: "",
      body: "",
    })
    setHistory(null)
    setLocalError("")
  }
  async function versions(skill: Skill) {
    const revision = ++historyRequest.current
    setHistoryBusy(true)
    setLocalError("")
    try {
      const value = await state.versions(skill.id)
      if (revision === historyRequest.current)
        setHistory({ skill, versions: value.versions })
    } catch {
      if (revision === historyRequest.current)
        setLocalError("Could not load revision history.")
    } finally {
      if (revision === historyRequest.current) setHistoryBusy(false)
    }
  }
  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (!value) leaveView()
      }}
    >
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Skills</SheetTitle>
          <SheetDescription>
            Reusable instructions for your bots. Each bot keeps the revisions
            you choose.
          </SheetDescription>
        </SheetHeader>
        <div className="flex items-center justify-between gap-2 border-y px-4 py-2">
          <Tabs
            value={tab}
            onValueChange={(value) => {
              leaveView()
              setTab(String(value))
              setHistory(null)
            }}
          >
            <TabsList>
              <TabsTrigger value="library">Library</TabsTrigger>
              <TabsTrigger value="archived">Archived</TabsTrigger>
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
                    setHistory(null)
                    setHostedImport(true)
                    setLocalError("")
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
            className="sr-only"
            tabIndex={-1}
            aria-label="Import skill Markdown"
            onChange={async (event) => {
              const file = event.target.files?.[0]
              event.target.value = ""
              if (!file || cannotReplace) return
              setLocalError("")
              if (file.size > 64_000) {
                setLocalError(
                  "Choose a Markdown file up to 64 KB and 16,000 characters."
                )
                return
              }
              leaveView()
              const expected = historyRequest.current
              setImporting(true)
              try {
                const body = await file.text()
                if (expected !== historyRequest.current) return
                if (body.length > 16_000 || !body.trim()) {
                  setLocalError("Use 1 to 16,000 characters.")
                  return
                }
                setDraft({
                  id: crypto.randomUUID(),
                  expectedRevision: 0,
                  name: file.name.replace(/\.(md|txt)$/i, "").slice(0, 80),
                  body,
                })
                setHistory(null)
              } catch {
                if (expected === historyRequest.current)
                  setLocalError("Could not read this file.")
              } finally {
                if (expected === historyRequest.current) setImporting(false)
              }
            }}
          />
        </div>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
          {(state.error || localError) && (
            <Alert>
              <AlertDescription>
                {localError || state.error}
                <Button
                  size="xs"
                  variant="link"
                  disabled={state.busy}
                  onClick={() => {
                    setLocalError("")
                    void state.refresh()
                  }}
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
              FOR {agentName.toUpperCase()} · {state.selection.skills.length}/4
            </h3>
            {!state.selection.skills.length && (
              <p className="text-sm text-muted-foreground">
                Choose skills below to guide new replies.
              </p>
            )}
            {state.selection.skills.map((skill) => {
              const latest = state.library.find((item) => item.id === skill.id)
              return (
                <div
                  key={skill.id}
                  className="flex items-center gap-2 rounded-md border px-3 py-2"
                >
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
                    aria-label={`Remove ${skill.name} from this bot`}
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
          {hostedImport ? (
            <HostedSkillImport
              onCancel={() => setHostedImport(false)}
              onPreview={(value) => {
                setDraft(value)
                setHostedImport(false)
              }}
            />
          ) : draft ? (
            <form
              className="space-y-4 rounded-lg border p-4"
              onSubmit={async (event) => {
                event.preventDefault()
                const saved = await state.save({
                  ...draft,
                  name: draft.name.trim(),
                  body: draft.body.trim(),
                })
                if (saved) setDraft(null)
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
                      A newer revision (v{currentDraft.revision}) is saved. Your
                      draft is preserved below. Review the saved version before
                      continuing.
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
                  This skill is archived. Cancel editing and restore it from
                  Archived first.
                </p>
              )}
              <Field>
                <FieldLabel htmlFor="skill-name">Name</FieldLabel>
                <Input
                  id="skill-name"
                  value={draft.name}
                  maxLength={80}
                  required
                  disabled={state.busy}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
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
                  onChange={(event) =>
                    setDraft({ ...draft, body: event.target.value })
                  }
                />
              </Field>
              <p className="text-xs text-muted-foreground">
                {draft.body.length.toLocaleString()}/16,000 characters. Keep
                secrets out of skills. Saving creates a revision; bots stay on
                their selected versions.
              </p>
              <div className="flex gap-2">
                <Button
                  type="submit"
                  size="sm"
                  disabled={
                    state.busy ||
                    !state.ready ||
                    conflict ||
                    currentDraft?.archived ||
                    !draft.name.trim() ||
                    !draft.body.trim()
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
          ) : history ? (
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-medium">{history.skill.name} · history</h3>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setHistory(null)}
                >
                  Back to library
                </Button>
              </div>
              {history.versions.map((version) => (
                <details
                  key={version.revision}
                  className="rounded-md border p-3"
                >
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
                          setHistory(null)
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
                .filter((skill) => skill.archived === (tab === "archived"))
                .map((skill) => (
                  <SkillRow
                    key={skill.id}
                    skill={skill}
                    state={state}
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
                      setHistory(null)
                    }}
                    onHistory={() => void versions(skill)}
                  />
                ))}
              {state.ready &&
                !state.library.some(
                  (skill) => skill.archived === (tab === "archived")
                ) && (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    {tab === "archived"
                      ? "No archived skills."
                      : "Teach a repeatable way of working."}
                  </p>
                )}
            </div>
          )}
        </div>
        <p className="border-t p-4 text-xs text-muted-foreground">
          Skills apply to new replies. They never grant tool access. Editing or
          archiving a library skill leaves pinned bot revisions intact.
        </p>
      </SheetContent>
    </Sheet>
  )
}
function SkillRow({
  skill,
  state,
  historyBusy,
  onEdit,
  onHistory,
}: {
  skill: Skill
  state: SkillsState
  historyBusy: boolean
  onEdit: () => void
  onHistory: () => void
}) {
  const selected = state.selection.skills.some((value) => value.id === skill.id)
  return (
    <article className="space-y-2 py-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate font-medium">{skill.name}</h3>
        <span className="text-xs text-muted-foreground">v{skill.revision}</span>
      </div>
      <p className="line-clamp-2 text-sm text-muted-foreground">{skill.body}</p>
      <SkillSourceLabel source={skill.source} />
      <div className="flex flex-wrap justify-end gap-1">
        <Button
          size="xs"
          variant="ghost"
          disabled={state.busy || historyBusy}
          onClick={onHistory}
        >
          History
        </Button>
        {!skill.archived && (
          <>
            <Button
              size="xs"
              variant="ghost"
              disabled={state.busy}
              onClick={onEdit}
            >
              Edit
            </Button>
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
              {selected ? "Selected" : "Use for this bot"}
            </Button>
          </>
        )}
        <Button
          size="xs"
          variant="ghost"
          disabled={state.busy}
          onClick={() => void state.archive(skill)}
        >
          {skill.archived ? "Restore" : "Archive"}
        </Button>
      </div>
    </article>
  )
}
