import { Check, RefreshCw } from "lucide-react"
import { useEffect } from "react"

import { SettingsSection } from "@/components/settings-section"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

import { useAccess } from "./use-access"

export function AccessPanel({
  embedded = false,
  onPendingChange,
  agentId,
  agentName,
  open,
  onOpenChange: setOpen,
  onSaved,
}: {
  embedded?: boolean
  onPendingChange?: (pending: boolean) => void
  agentId: string
  agentName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const { policies, busy, error, loading, update, refresh } = useAccess(
    agentId,
    open,
    onSaved
  )
  const pending = !!busy
  useEffect(() => {
    onPendingChange?.(pending)
    return () => onPendingChange?.(false)
  }, [pending, onPendingChange])
  return (
    <SettingsSection
      embedded={embedded}
      open={open}
      onOpenChange={setOpen}
      title="Tool access"
      description={
        <>Choose what {agentName} can do. Permissions apply to this bot only.</>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        {error && (
          <Alert className="my-3">
            <AlertDescription>
              {error}
              <Button
                size="xs"
                variant="link"
                disabled={!!busy || loading}
                onClick={refresh}
              >
                <RefreshCw />
                Reload
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {!policies && !error && (
          <p className="py-4 text-sm text-muted-foreground">
            Loading tool access…
          </p>
        )}
        <div className="divide-y">
          {policies?.map((tool) => (
            <section
              key={tool.name}
              className="flex flex-col gap-3 py-4"
              aria-label={tool.title ?? tool.name}
            >
              <div>
                <h3 className="text-sm font-medium">
                  {tool.title ?? tool.name}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {tool.description}
                </p>
              </div>
              <ToggleGroup
                variant="outline"
                size="sm"
                value={[tool.mode]}
                disabled={!!busy || loading}
                aria-label={`Access for ${tool.title ?? tool.name}`}
                onValueChange={(values) => {
                  const value = values[0]
                  if (value === "allow" || value === "ask" || value === "deny")
                    void update(tool, value)
                }}
              >
                {(["allow", "ask", "deny"] as const).map((mode) => (
                  <ToggleGroupItem key={mode} value={mode}>
                    <Check
                      aria-hidden="true"
                      className={tool.mode === mode ? "" : "invisible"}
                      data-icon="inline-start"
                    />
                    {mode === "allow"
                      ? "Allow"
                      : mode === "ask"
                        ? "Ask"
                        : "Deny"}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              {busy === tool.name && (
                <p role="status" className="text-xs text-muted-foreground">
                  Saving…
                </p>
              )}
            </section>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2 border-t p-4 text-xs text-muted-foreground">
        <p>
          <strong>Allow</strong> runs automatically with any inputs and stays
          saved until you change it. <strong>Ask</strong> pauses for your
          approval of the exact inputs. <strong>Deny</strong> blocks the tool.
        </p>
        <p>
          Changes apply before an action starts. An action already running may
          finish. Individual action requests expire after 15 minutes and are
          cancelled when you stop the reply.
        </p>
      </div>
    </SettingsSection>
  )
}
