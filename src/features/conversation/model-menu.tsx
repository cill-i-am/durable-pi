import { useModelCatalog } from "./use-model-catalog"
import { ChevronDown, Settings2, Sparkles } from "lucide-react"
import type { ModelSelection } from "@/conversations/turns"
import { resolveRoute, type Profile, type JobType } from "@/inference/policy"
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
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"

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
  labels: "Titles and labels",
  extraction: "Structured extraction",
} as const
export function ModelMenu({
  agentId,
  selection,
  onError,
  profile,
  onProfile,
  job,
  onJob,
  disabled,
  onOpenSettings,
}: {
  agentId: string
  selection: ModelSelection
  onError: (message: string) => void
  profile: Profile
  onProfile: (value: Profile) => void
  job: JobType
  onJob: (value: JobType) => void
  disabled: boolean
  onOpenSettings: () => void
}) {
  const { catalog, refresh, unavailable } = useModelCatalog(
    agentId,
    selection.settingsRevision,
    onError
  )
  const route = resolveRoute(
    job,
    catalog?.assignments[job] ??
      (job === "conversation" ? selection : undefined),
    profile
  )
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
              title={`${route.model} · ${route.thinking}`}
            />
          }
          aria-label="Model profile"
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
          <DropdownMenuItem onClick={onOpenSettings}>
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
    </>
  )
}
