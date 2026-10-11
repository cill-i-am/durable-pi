import { useEffect, useId, useState } from "react"
import { Check, RefreshCw } from "lucide-react"
import { Schema } from "effect"
import { ModelSelection, type ModelSettings } from "@/conversations/turns"
import { resolveRoute, type JobType } from "@/inference/policy"
import { agentApi } from "@/http/client"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select"
import { useModelCatalog } from "./use-model-catalog"

const settingsJobs = {
  conversation: "Everyday conversation",
  implementation: "Implementation",
  planning: "Deep planning",
  review: "Critical review",
  labels: "Titles and labels",
  extraction: "Structured extraction",
  memory: "Memory summaries",
} as const
export function ModelDefaults({
  agentId,
  selection,
  onSaved,
  onPendingChange,
}: {
  agentId: string
  selection: ModelSelection
  onSaved: () => void
  onPendingChange: (pending: boolean) => void
}) {
  const labels = useId()
  const [error, setError] = useState("")
  const { catalog, refresh, unavailable, setCatalog, requestSequence } =
    useModelCatalog(agentId, selection.settingsRevision, setError)
  const [settingsJob, setSettingsJob] = useState<JobType>("conversation")
  const [draft, setDraft] = useState<ModelSettings>(selection)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    if (!dirty && !saving)
      setDraft(
        catalog?.assignments[settingsJob] ??
          (settingsJob === "conversation"
            ? selection
            : resolveRoute(settingsJob))
      )
  }, [
    catalog,
    settingsJob,
    selection.model,
    selection.thinking,
    selection.settingsRevision,
    dirty,
    saving,
  ])
  useEffect(() => {
    onPendingChange(dirty || saving)
  }, [dirty, saving, onPendingChange])
  async function save() {
    if (saving || unavailable(draft)) return
    setSaving(true)
    setError("")
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
      setDirty(false)
      setSaved(true)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save model settings."
      )
    } finally {
      setSaving(false)
    }
  }
  const model = catalog?.models.find((m) => m.id === draft.model)
  return (
    <section className="settings-section" aria-label="Models">
      <header className="settings-section-heading">
        <h2>Models & connections</h2>
        <p>Your ChatGPT subscription and the right model for each job.</p>
      </header>
      <div className="settings-section-body">
        <h3 className="settings-eyebrow">Model connection</h3>
        <div className="settings-provider">
          <div className="flex items-center justify-between gap-3">
            <strong>ChatGPT</strong>
            <Badge variant="secondary">
              {catalog?.checkedAt && !catalog.error
                ? "Connected"
                : catalog?.error
                  ? "Needs attention"
                  : "Checking…"}
            </Badge>
          </div>
          <p>
            Uses your ChatGPT subscription. Model availability comes from this
            connection.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={() => {
              setError("")
              void refresh()
            }}
          >
            <RefreshCw />
            Refresh connection
          </Button>
        </div>
        {(error || catalog?.error) && (
          <Alert>
            <AlertDescription>{error || catalog?.error}</AlertDescription>
          </Alert>
        )}
        <div className="settings-rule" />
        <div>
          <h3>Defaults for this agent</h3>
          <p className="settings-description">
            Used by Auto for new jobs. Running jobs keep their model.
          </p>
        </div>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${labels}-job`}>Job</FieldLabel>
            <Select
              value={settingsJob}
              disabled={saving || dirty || !catalog}
              onValueChange={(value) => {
                if (value) {
                  setSettingsJob(value)
                  setDraft(catalog?.assignments[value] ?? resolveRoute(value))
                }
              }}
            >
              <SelectTrigger id={`${labels}-job`} className="w-full">
                <SelectValue>{settingsJobs[settingsJob]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {Object.entries(settingsJobs).map(([value, name]) => (
                    <SelectItem key={value} value={value}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${labels}-model`}>Model</FieldLabel>
            <Select
              value={draft.model}
              disabled={saving || !catalog}
              onValueChange={(value) => {
                if (value) {
                  setDirty(true)
                  setSaved(false)
                  setDraft({ ...draft, model: value })
                }
              }}
            >
              <SelectTrigger id={`${labels}-model`} className="w-full">
                <SelectValue>{model?.name ?? draft.model}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
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
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${labels}-effort`}>
              Reasoning effort
            </FieldLabel>
            <Select
              value={draft.thinking}
              disabled={saving || !catalog}
              onValueChange={(value) => {
                if (value) {
                  setDirty(true)
                  setSaved(false)
                  setDraft({
                    ...draft,
                    thinking: value,
                  })
                }
              }}
            >
              <SelectTrigger id={`${labels}-effort`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {model?.thinking.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>

        {unavailable(draft) && (
          <p role="status" className="settings-description">
            {unavailable(draft)}
          </p>
        )}
        <div className="settings-save-row">
          <span role="status" className="settings-save-status">
            {saved && (
              <>
                <Check /> Saved
              </>
            )}
          </span>
          {dirty && (
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setDirty(false)
                setSaved(false)
                setError("")
              }}
            >
              Cancel changes
            </Button>
          )}
          <Button
            disabled={saving || !dirty || !!unavailable(draft)}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save default"}
          </Button>
        </div>
      </div>
    </section>
  )
}
