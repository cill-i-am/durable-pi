import { useRef, useState } from "react"
import { ShieldCheck, RefreshCw } from "lucide-react"
import { Schema } from "effect"
import {
  AccessState,
  type AccessMode,
  type ToolPolicy,
} from "@/access/contracts"
import { agentApi } from "@/http/client"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"

export function AccessPanel({
  agentId,
  agentName,
  tools,
  onSaved,
}: {
  agentId: string
  agentName: string
  tools: readonly ToolPolicy[] | undefined
  onSaved: () => void
}) {
  const [confirmed, setConfirmed] = useState<readonly ToolPolicy[]>([])
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const lock = useRef(false)
  // A successful mutation must not be rolled back by an older stream snapshot.
  const policies = tools?.map((tool) => {
    const saved = confirmed.find((value) => value.name === tool.name)
    return saved && saved.revision > tool.revision ? saved : tool
  })
  async function update(tool: ToolPolicy, mode: AccessMode) {
    if (lock.current || tool.mode === mode) return
    lock.current = true
    setBusy(tool.name)
    setError("")
    try {
      const state = Schema.decodeUnknownSync(AccessState)(
        await agentApi(agentId)("access/policy", {
          name: tool.name,
          expectedRevision: tool.revision,
          mode,
        })
      )
      setConfirmed(state.tools)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update access."
      )
    } finally {
      lock.current = false
      setBusy("")
      onSaved()
    }
  }
  return (
    <Sheet>
      <SheetTrigger
        render={<Button variant="ghost" size="sm" aria-label="Tool access" />}
      >
        <ShieldCheck />
        <span className="hidden sm:inline">Tools</span>
      </SheetTrigger>
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Tool access</SheetTitle>
          <SheetDescription>
            Choose what {agentName} can do. These permissions apply to this bot
            only.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          {error && (
            <Alert className="my-3">
              <AlertDescription>
                {error}
                <Button
                  size="xs"
                  variant="link"
                  onClick={() => {
                    setError("")
                    onSaved()
                  }}
                >
                  <RefreshCw />
                  Reload
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {!policies && (
            <p className="py-4 text-sm text-muted-foreground">
              Loading tool access…
            </p>
          )}
          <div className="divide-y">
            {policies?.map((tool) => (
              <section
                key={tool.name}
                className="space-y-3 py-4"
                aria-label={tool.title ?? tool.name}
              >
                <div>
                  <h3 className="font-mono text-sm font-medium">
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
                  disabled={!!busy}
                  aria-label={`Access for ${tool.title ?? tool.name}`}
                  onValueChange={(values) => {
                    const value = values[0]
                    if (
                      value === "allow" ||
                      value === "ask" ||
                      value === "deny"
                    )
                      void update(tool, value)
                  }}
                >
                  <ToggleGroupItem value="allow">Allow</ToggleGroupItem>
                  <ToggleGroupItem value="ask">Ask</ToggleGroupItem>
                  <ToggleGroupItem value="deny">Deny</ToggleGroupItem>
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
        <div className="space-y-2 border-t p-4 text-xs text-muted-foreground">
          <p>
            <strong>Allow</strong> runs automatically. <strong>Ask</strong>{" "}
            pauses for your approval of the exact inputs. <strong>Deny</strong>{" "}
            blocks the tool.
          </p>
          <p>
            Changes apply before an action starts. An action already running may
            finish. Approvals expire after 15 minutes and are cancelled when you
            stop the reply.
          </p>
        </div>
      </SheetContent>
    </Sheet>
  )
}
