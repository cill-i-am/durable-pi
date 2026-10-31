import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { Check } from "lucide-react"
import { useCallback, useId, useRef } from "react"

import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select"
import type { ModelSettings } from "@/conversations/turns"
import { resolveRoute } from "@/inference/policy"

import type { useModelCatalog } from "./use-model-catalog"
import { useModelDefaults, type ModelDefaultsProps } from "./use-model-defaults"

const settingsJobs = {
  conversation: "Everyday conversation",
  implementation: "Implementation",
  planning: "Deep planning",
  review: "Critical review",
  labels: "Titles and labels",
  extraction: "Structured extraction",
  memory: "Memory summaries",
} as const
export function ModelDefaults(props: ModelDefaultsProps) {
  const agent = useRef(props.agentId)
  agent.current = props.agentId
  const currentAgent = useCallback(() => agent.current, [])
  return (
    <ModelDefaultsView
      key={props.agentId}
      {...props}
      currentAgent={currentAgent}
    />
  )
}
function ModelDefaultsView(
  props: ModelDefaultsProps & { currentAgent: () => string }
) {
  const labels = useId()
  const { onModelAccess } = props
  const state = useModelDefaults(props, props.currentAgent)
  const {
    catalog,
    catalogError,
    unavailable,
    draft,
    dirty,
    saved,
    error,
    unconfirmed,
    busy: saving,
    job: settingsJob,
  } = state
  return (
    <section className="settings-section" aria-label="Models">
      <header className="settings-section-heading flex flex-wrap items-center justify-between gap-3">
        <h2>Models</h2>
        {onModelAccess && (
          <Button
            size="sm"
            variant="link"
            disabled={dirty || saving || unconfirmed}
            onClick={onModelAccess}
          >
            Model access
          </Button>
        )}
      </header>
      <div className="settings-section-body settings-model-form">
        {(error || catalogError) && (
          <Alert>
            <AlertDescription>
              {error || catalogError}
              <Button
                size="sm"
                variant="link"
                disabled={saving}
                onClick={() => void state.event({ type: "REFRESH" })}
              >
                Reload models
              </Button>
            </AlertDescription>
          </Alert>
        )}
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
                  void state.event({
                    type: "JOB",
                    job: value,
                    draft: catalog?.assignments[value] ?? resolveRoute(value),
                    settingsRevision:
                      catalog?.selection.settingsRevision ??
                      props.selection.settingsRevision,
                  })
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
          <ModelChoices
            labels={labels}
            catalog={catalog}
            draft={draft}
            saving={saving}
            onChange={(next) => {
              void state.change(next)
            }}
          />
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
                void state.event({ type: "CANCEL" })
              }}
            >
              Cancel changes
            </Button>
          )}
          <Button
            disabled={
              saving || (!unconfirmed && (!dirty || !!unavailable(draft)))
            }
            onClick={() =>
              void state.event({ type: unconfirmed ? "CHECK" : "SAVE" })
            }
          >
            {saving
              ? "Saving…"
              : unconfirmed
                ? "Check saved default"
                : "Save default"}
          </Button>
        </div>
      </div>
    </section>
  )
}

function ModelChoices({
  labels,
  catalog,
  draft,
  saving,
  onChange,
}: {
  labels: string
  catalog: ReturnType<typeof useModelCatalog>["catalog"]
  draft: ModelSettings
  saving: boolean
  onChange: (value: ModelSettings) => void
}) {
  const model = catalog?.models.find((m) => m.id === draft.model)
  return (
    <>
      {" "}
      <Field>
        <FieldLabel htmlFor={`${labels}-model`}>Model</FieldLabel>
        <Select
          value={draft.model}
          disabled={saving || !catalog}
          onValueChange={(value) => {
            if (value) {
              onChange({ ...draft, model: value })
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
        <FieldLabel htmlFor={`${labels}-effort`}>Reasoning effort</FieldLabel>
        <Select
          value={draft.thinking}
          disabled={saving || !catalog}
          onValueChange={(value) => {
            if (value) {
              onChange({
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
    </>
  )
}
