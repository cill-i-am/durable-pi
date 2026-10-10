import { useEffect, useState } from "react"
import { ChevronDown, Sparkles } from "lucide-react"
import { Schema } from "effect"
import { ModelSelection, ThinkingLevel } from "@/conversations/turns"
import { newestSelection } from "./commands"
import { agentApi } from "@/http/client"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"

const Catalog = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      thinking: Schema.Array(ThinkingLevel),
    })
  ),
  selection: ModelSelection,
})

export function ModelMenu({
  agentId,
  selection,
  onSaved,
  onError,
}: {
  agentId: string
  selection: ModelSelection
  onSaved: () => void
  onError: (message: string) => void
}) {
  const [models, setModels] = useState<(typeof Catalog.Type)["models"]>([])
  const [saving, setSaving] = useState(false)
  const [reload, setReload] = useState(0)
  const [confirmed, setConfirmed] = useState<ModelSelection | null>(null)
  const { model, thinking } = newestSelection(selection, confirmed)
  useEffect(() => {
    const controller = new AbortController()
    agentApi(agentId)("models", undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted)
          setModels(Schema.decodeUnknownSync(Catalog)(value).models)
      })
      .catch(() => {
        if (!controller.signal.aborted)
          onError("Could not load models. Open the model menu to retry.")
      })
    return () => controller.abort()
  }, [agentId, reload, onError])
  const selected = models.find((item) => item.id === model)
  async function save(nextModel: string, nextThinking: ThinkingLevel) {
    setSaving(true)
    try {
      const result = await agentApi(agentId)("settings", {
        model: nextModel,
        thinking: nextThinking,
      })
      setConfirmed(Schema.decodeUnknownSync(ModelSelection)(result))
      onSaved()
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Could not change model."
      )
    } finally {
      setSaving(false)
    }
  }
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open && !models.length) setReload((n) => n + 1)
      }}
    >
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={saving}
            className="max-w-full min-w-0"
          />
        }
        aria-label="Model and reasoning"
      >
        <Sparkles data-icon="inline-start" />
        <span className="truncate">
          {saving ? "Saving…" : (selected?.name ?? model)}
        </span>
        <ChevronDown data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Model · applies to new replies</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            className="max-h-56 overflow-y-auto"
            value={model}
            onValueChange={(value) => {
              const next = models.find((item) => item.id === value)
              if (next)
                void save(
                  next.id,
                  next.thinking.find((level) => level === thinking) ??
                    next.thinking[0] ??
                    "off"
                )
            }}
          >
            {models.map((item) => (
              <DropdownMenuRadioItem
                key={item.id}
                value={item.id}
                disabled={saving}
              >
                {item.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Reasoning</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={thinking}
            onValueChange={(value) => {
              if (selected?.thinking.includes(value as ThinkingLevel))
                void save(model, value as ThinkingLevel)
            }}
          >
            {selected?.thinking.map((level) => (
              <DropdownMenuRadioItem
                key={level}
                value={level}
                disabled={saving}
              >
                {level === "off"
                  ? "Off"
                  : level.charAt(0).toUpperCase() + level.slice(1)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
