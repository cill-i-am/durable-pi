import { useCallback, useEffect, useState, useRef, useId } from "react"
import { ChevronDown, Settings2, Sparkles } from "lucide-react"
import { Schema } from "effect"
import { ModelSelection, type ModelSettings } from "@/conversations/turns"
import {
  ModelCatalog,
  ResolvedRoute,
  resolveRoute,
  validateRoute,
  type Profile,
  type JobType,
} from "@/inference/policy"
import { agentApi } from "@/http/client"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"

const Catalog = Schema.Struct({
  ...ModelCatalog.fields,
  selection: ModelSelection,
  assignments: Schema.Record(Schema.String, ResolvedRoute),
})
const names: Record<Profile, string> = {
  auto: "Auto",
  fast: "Fast",
  balanced: "Balanced",
  deep: "Deep",
  "think-harder": "Think harder",
}
const jobs = {
  conversation: "Everyday conversation",
  implementation: "Implementation",
  planning: "Deep planning",
  review: "Critical review",
} as const
export function ModelMenu({
  agentId,
  selection,
  onSaved,
  onError,
  profile,
  onProfile,
  job,
  onJob,
  disabled,
}: {
  agentId: string
  selection: ModelSelection
  onSaved: () => void
  onError: (message: string) => void
  profile: Profile
  onProfile: (value: Profile) => void
  job: JobType
  onJob: (value: JobType) => void
  disabled: boolean
}) {
  const requestSequence = useRef(0)
  const labels = useId()
  const [catalog, setCatalog] = useState<typeof Catalog.Type | null>(null)
  const [settings, setSettings] = useState(false),
    [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState<ModelSettings>(selection)
  const [settingsJob, setSettingsJob] = useState<JobType>("conversation")
  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current
    try {
      const next = Schema.decodeUnknownSync(Catalog)(
        await agentApi(agentId)("models")
      )
      if (sequence === requestSequence.current)
        setCatalog((current) =>
          current &&
          current.selection.settingsRevision > next.selection.settingsRevision
            ? current
            : next
        )
    } catch {
      if (sequence === requestSequence.current)
        onError(
          "Could not verify model availability. Reopen the menu to retry."
        )
    }
  }, [agentId, onError])
  useEffect(() => {
    void refresh()
    return () => {
      requestSequence.current++
    }
  }, [refresh, selection.settingsRevision])
  const route = resolveRoute(
    job,
    catalog?.assignments[job] ??
      (job === "conversation" ? selection : undefined),
    profile
  )
  function unavailable(value: ModelSettings) {
    if (!catalog) return "Checking account availability…"
    try {
      validateRoute(value, catalog)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : "Unavailable"
    }
  }
  async function save() {
    if (saving || unavailable(draft)) return
    setSaving(true)
    requestSequence.current++
    try {
      const confirmed = Schema.decodeUnknownSync(ModelSelection)(
        await agentApi(agentId)("settings", { ...draft, job: settingsJob })
      )
      requestSequence.current++
      setCatalog((current) =>
        current &&
        current.selection.settingsRevision > confirmed.settingsRevision
          ? current
          : current
            ? {
                ...current,
                selection: confirmed,
                assignments: {
                  ...current.assignments,
                  [settingsJob]: resolveRoute(settingsJob, draft),
                },
              }
            : current
      )
      await refresh()
      onSaved()
      setSettings(false)
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Could not save model settings."
      )
    } finally {
      setSaving(false)
    }
  }
  const model = catalog?.models.find((m) => m.id === draft.model)
  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) void refresh()
        }}
      >
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={disabled}
              className="max-w-full min-w-0"
            />
          }
          aria-label="Model profile"
        >
          <Sparkles data-icon="inline-start" />
          <span className="truncate">
            {names[profile]} · {route.model} · {route.thinking}
          </span>
          <ChevronDown data-icon="inline-end" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          className="max-h-[70dvh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel>
              This message · ChatGPT plan usage
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={profile}
              onValueChange={(value) => onProfile(value as Profile)}
            >
              {(["auto", "fast", "balanced", "deep"] as const).map((value) => {
                const option = resolveRoute(
                  job,
                  catalog?.assignments[job] ??
                    (job === "conversation" ? selection : undefined),
                  value
                )
                const reason = unavailable(option)
                return (
                  <DropdownMenuRadioItem
                    key={value}
                    value={value}
                    disabled={!!reason}
                    className="items-start whitespace-normal"
                  >
                    <span className="flex flex-col gap-1">
                      <span>{names[value]}</span>
                      <span className="text-xs text-muted-foreground">
                        {option.model} · {option.thinking}
                      </span>
                      {reason && (
                        <span className="text-xs text-muted-foreground">
                          {reason}
                        </span>
                      )}
                    </span>
                  </DropdownMenuRadioItem>
                )
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Advanced · explicit job</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={job}
              onValueChange={(value) => onJob(value as JobType)}
            >
              {Object.entries(jobs).map(([value, name]) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  {name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuRadioGroup
              value={profile}
              onValueChange={() => onProfile("think-harder")}
            >
              <DropdownMenuRadioItem
                value="think-harder"
                disabled={
                  !!unavailable(resolveRoute(job, undefined, "think-harder"))
                }
              >
                Think harder · Astra xhigh
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              setSettingsJob(job)
              setDraft(catalog?.assignments[job] ?? route)
              setSettings(true)
            }}
          >
            <Settings2 /> Agent job defaults
          </DropdownMenuItem>
          <p className="px-2 py-2 text-xs text-muted-foreground">
            One-message overrides reset after sending. Steering keeps the active
            reply’s model.
          </p>
          {catalog?.error && (
            <p role="alert" className="px-2 pb-2 text-xs text-destructive">
              {catalog.error}
            </p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={settings}
        onOpenChange={(open) => {
          if (!saving) setSettings(open)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Agent job defaults</DialogTitle>
            <DialogDescription>
              Used by Auto for new jobs on this agent. Running jobs keep their
              model.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${labels}-job`}>Job</FieldLabel>
              <Select
                value={settingsJob}
                disabled={saving}
                onValueChange={(value) => {
                  if (value) {
                    setSettingsJob(value)
                    setDraft(catalog?.assignments[value] ?? resolveRoute(value))
                  }
                }}
              >
                <SelectTrigger id={`${labels}-job`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(jobs).map(([value, name]) => (
                    <SelectItem key={value} value={value}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${labels}-model`}>Model</FieldLabel>
              <Select
                value={draft.model}
                disabled={saving}
                onValueChange={(value) => {
                  if (value) setDraft({ ...draft, model: value })
                }}
              >
                <SelectTrigger id={`${labels}-model`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {catalog?.models.map((value) => (
                    <SelectItem
                      key={value.id}
                      value={value.id}
                      disabled={!!value.unavailable}
                    >
                      {value.name}
                      {value.unavailable ? " · unavailable" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${labels}-effort`}>
                Reasoning effort
              </FieldLabel>
              <Select
                value={draft.thinking}
                disabled={saving}
                onValueChange={(value) => {
                  if (value)
                    setDraft({
                      ...draft,
                      thinking: value,
                    })
                }}
              >
                <SelectTrigger id={`${labels}-effort`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {model?.thinking.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          {unavailable(draft) && (
            <Alert>
              <AlertDescription>{unavailable(draft)}</AlertDescription>
            </Alert>
          )}
          <Button
            disabled={saving || !!unavailable(draft)}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save default"}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  )
}
