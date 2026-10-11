import { useState } from "react"
import { ArrowUpRight, Globe, RefreshCw, Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { agentUrl } from "@/http/client"
import { BrowserControls } from "./browser-controls"
import { useBrowser } from "./use-browser"

export function BrowserWorkbench({
  agentId,
  agentName,
}: {
  agentId: string
  agentName: string
}) {
  const browser = useBrowser(agentId)
  const [failedScreenshot, setFailedScreenshot] = useState<number | null>(null)
  const [url, setUrl] = useState("")
  const [settings, setSettings] = useState<{
    generation: number
    hosts: string
  } | null>(null)
  const state = browser.state
  const content = (
    <>
      <div className="workbench-heading-row">
        <div className="flex min-w-0 items-center gap-2">
          <Globe className="size-4" />
          <span className="text-sm font-medium">Browser</span>
          <Badge variant="secondary">{state?.status ?? "Loading"}</Badge>
        </div>
        <div className="flex gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Allowed browser sites"
            disabled={!state || browser.busy}
            onClick={() =>
              setSettings({
                generation: state!.policy.generation,
                hosts: state!.policy.hosts.join("\n"),
              })
            }
          >
            <Settings2 />
          </Button>
        </div>
      </div>
      <div className="workbench-body">
        {(browser.error || state?.error) && (
          <Alert>
            <AlertDescription>
              {browser.error || state?.error}
              <Button
                size="xs"
                variant="link"
                disabled={browser.busy}
                onClick={() => void browser.refresh()}
              >
                Reload
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {settings ? (
          <form
            onSubmit={async (event) => {
              event.preventDefault()
              const hosts = settings.hosts
                .split(/\s+/)
                .filter(Boolean)
                .map((host) => host.toLowerCase())
              if (
                await browser.command("policy", {
                  generation: settings.generation,
                  hosts,
                })
              )
                setSettings(null)
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="browser-sites">
                  Allowed sites for {agentName}
                </FieldLabel>
                <Textarea
                  id="browser-sites"
                  className="min-h-28 font-mono text-sm"
                  placeholder={"example.com\nwww.example.com"}
                  value={settings.hosts}
                  onChange={(event) =>
                    setSettings({ ...settings, hosts: event.target.value })
                  }
                  disabled={browser.busy}
                />
              </Field>
              <p className="text-xs text-muted-foreground">
                Up to 20 exact hostnames, one per line. Subdomains must be
                listed separately. Cloudflare’s common CDN set is allowed for
                page assets. Changing sites closes this session and clears its
                preview.
              </p>
              {state && settings.generation !== state.policy.generation && (
                <p className="text-sm text-destructive">
                  Settings changed elsewhere. Cancel and reopen settings to
                  review them.
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  type="submit"
                  size="sm"
                  disabled={
                    browser.busy ||
                    settings.generation !== state?.policy.generation
                  }
                >
                  Save allowed sites
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={browser.busy}
                  onClick={() => setSettings(null)}
                >
                  Cancel
                </Button>
              </div>
            </FieldGroup>
          </form>
        ) : (
          <>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (state)
                  void browser.command("open", {
                    generation: state.policy.generation,
                    url,
                  })
              }}
            >
              <Input
                aria-label="Browser URL"
                type="url"
                placeholder="https://example.com"
                value={url}
                maxLength={2048}
                onChange={(event) => setUrl(event.target.value)}
                disabled={browser.busy || !state}
                required
              />
              <Button
                type="submit"
                size="sm"
                disabled={
                  browser.busy || !state || !url || !state.policy.hosts.length
                }
              >
                {browser.pending === "open" ? "Opening…" : "Go"}
              </Button>
            </form>
            {state && !state.policy.hosts.length && (
              <div className="flex flex-col items-start gap-3 rounded-lg border p-5">
                <Globe className="size-6 text-muted-foreground" />
                <h3 className="font-medium">
                  Give this bot somewhere to browse
                </h3>
                <p className="text-sm text-muted-foreground">
                  Choose the sites it may visit. Browser tools ask for your
                  approval unless you change their tool permissions.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setSettings({
                      generation: state.policy.generation,
                      hosts: "",
                    })
                  }
                >
                  Choose allowed sites
                </Button>
              </div>
            )}
            {state?.page && (
              <>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-sm font-medium break-words">
                      {state.page.title || "Browser page"}
                    </h3>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {state.page.url}
                    </p>
                  </div>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    nativeButton={false}
                    render={
                      <a
                        href={state.page.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      />
                    }
                    aria-label="Open page in your browser"
                  >
                    <ArrowUpRight />
                  </Button>
                </div>
                {state.controller === "owner" ? (
                  <BrowserControls
                    key={state.policy.generation}
                    agentId={agentId}
                    state={state}
                    busy={browser.busy}
                    refresh={() => void browser.refresh()}
                    act={(action) =>
                      browser.command("interact", {
                        generation: state.policy.generation,
                        version: state.version,
                        action,
                      })
                    }
                  />
                ) : (
                  state.hasScreenshot &&
                  failedScreenshot !== state.version && (
                    <img
                      src={`${agentUrl(agentId, "browser/screenshot")}&version=${state.version}`}
                      onError={() => {
                        setFailedScreenshot(state.version)
                        void browser.refresh()
                      }}
                      alt={`Last captured view of ${state.page.title || state.page.url}`}
                      className="w-full rounded-md border bg-white"
                    />
                  )
                )}
                <p className="text-xs text-muted-foreground">
                  Captured{" "}
                  {new Date(state.page.capturedAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  . This is a snapshot; refresh to inspect changes.
                </p>
                <details className="rounded-md border p-3">
                  <summary className="cursor-pointer text-sm">
                    Page text · {state.page.text.length.toLocaleString()}{" "}
                    characters
                  </summary>
                  <pre className="mt-3 text-xs break-words whitespace-pre-wrap">
                    {state.page.text || "No readable text was found."}
                  </pre>
                </details>
                {!!state.page.links.length && (
                  <details className="rounded-md border p-3">
                    <summary className="cursor-pointer text-sm">
                      Page links · {state.page.links.length}
                    </summary>
                    <ul className="mt-3 flex flex-col gap-2">
                      {state.page.links.map((link, index) => (
                        <li key={index}>
                          <button
                            type="button"
                            className="max-w-full truncate text-left text-xs text-primary underline underline-offset-2"
                            onClick={() => setUrl(link.url)}
                          >
                            {link.text}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
            {state &&
              (state.expiresAt ||
                browser.busy ||
                state.status === "loading") && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      browser.busy ||
                      !state.expiresAt ||
                      state.status === "expired"
                    }
                    onClick={() =>
                      void browser.command("refresh", {
                        generation: state.policy.generation,
                      })
                    }
                  >
                    <RefreshCw />
                    Refresh view
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      browser.busy ||
                      !state.expiresAt ||
                      state.status === "expired"
                    }
                    onClick={() =>
                      void browser.command("control", {
                        generation: state.policy.generation,
                        controller:
                          state.controller === "owner" ? "agent" : "owner",
                      })
                    }
                  >
                    {state.controller === "owner"
                      ? "Return control to bot"
                      : "Take control"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={browser.pending === "close"}
                    onClick={() =>
                      void browser.command(
                        "close",
                        { generation: state.policy.generation },
                        true
                      )
                    }
                  >
                    Close session
                  </Button>
                </div>
              )}
          </>
        )}
      </div>
      <p className="border-t p-4 text-xs text-muted-foreground">
        Private to {agentName}. Sessions expire after two idle minutes or ten
        minutes total. Hiding this panel leaves the session running until it
        expires.
      </p>
    </>
  )
  return content
}
