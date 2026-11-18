import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { DataLoading } from "@workspace/ui/components/data-loading"
import { Input } from "@workspace/ui/components/input"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@workspace/ui/components/toggle-group"
import { Check, RefreshCw, Search } from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"

import { SettingsSection } from "@/components/settings-section"

import { useAccess } from "./use-access"

export function AccessPanel({
  onPendingChange,
  agentId,
  agentName,
  open,
  onSaved,
  children,
}: {
  onPendingChange?: (pending: boolean) => void
  agentId: string
  agentName: string
  open: boolean
  onSaved: () => void
  children?: ReactNode
}) {
  const { policies, busy, error, loading, update, refresh } = useAccess(
    agentId,
    open,
    onSaved
  )
  const pending = !!busy
  const [query, setQuery] = useState("")
  const filter = useRef<HTMLInputElement>(null)
  const normalized = query.trim().toLowerCase()
  const shown = policies?.filter((tool) =>
    `${tool.name} ${tool.title ?? ""} ${tool.description}`
      .toLowerCase()
      .includes(normalized)
  )
  useEffect(() => {
    onPendingChange?.(pending)
    return () => onPendingChange?.(false)
  }, [pending, onPendingChange])
  return (
    <SettingsSection
      open={open}
      title="Tool access"
      description={`Permissions apply to ${agentName} only.`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-[1_1_240px]">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 z-1 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            ref={filter}
            className="pl-9"
            aria-label="Filter tools"
            placeholder="Filter tools…"
            maxLength={200}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {children}
      </div>
      <div className="settings-panel-body">
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
          <DataLoading loading label="Loading tool access" layout="form" />
        )}
        <div className="divide-y">
          {shown?.map((tool) => (
            <section
              key={tool.name}
              className="settings-access-row"
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
        {normalized && shown?.length === 0 && (
          <div role="status" className="flex flex-col items-center gap-4 py-8">
            <h3 className="text-sm font-medium">No matching tools</h3>
            <Button
              variant="outline"
              onClick={() => {
                filter.current?.focus()
                setQuery("")
              }}
            >
              Clear filter
            </Button>
          </div>
        )}
      </div>
      <div className="settings-panel-footer space-y-2">
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
