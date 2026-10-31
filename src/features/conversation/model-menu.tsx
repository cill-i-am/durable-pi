import { Button } from "@workspace/ui/components/button"
import { ChevronDown, Sparkles } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu"
import type { ModelSelection } from "@/conversations/turns"
import { resolveRoute, type Profile } from "@/inference/policy"

import { useModelCatalog } from "./use-model-catalog"

const names: Record<Profile, string> = {
  auto: "Auto",
  fast: "Fast",
  balanced: "Balanced",
  deep: "Deep",
  "think-harder": "Think harder",
}
export function ModelMenu({
  agentId,
  selection,
  profile,
  onProfile,
  disabled,
}: {
  agentId: string
  selection: ModelSelection
  profile: Profile
  onProfile: (value: Profile) => void
  disabled: boolean
}) {
  const { catalog, refresh, unavailable } = useModelCatalog(
    agentId,
    selection.settingsRevision
  )
  const route = resolveRoute(
    "conversation",
    catalog?.assignments.conversation ?? selection,
    profile
  )
  return (
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
            title={`${route.model} · ${route.thinking}`}
          />
        }
        aria-label="Model"
      >
        <Sparkles data-icon="inline-start" />
        <span className="truncate">{names[profile]}</span>
        <ChevronDown data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        className="max-h-[70dvh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>Model</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={profile}
            onValueChange={(value) => onProfile(value as Profile)}
          >
            {(["auto", "fast", "balanced", "deep"] as const).map((value) => {
              const option = resolveRoute(
                "conversation",
                catalog?.assignments.conversation ?? selection,
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
        {catalog?.error && (
          <p role="alert" className="px-2 pb-2 text-xs text-destructive">
            {catalog.error}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
