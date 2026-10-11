import { useEffect, useState } from "react"
import { ArrowUpRight, Globe, RefreshCw, Settings2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { agentUrl } from "@/http/client"
import { useBrowser } from "./use-browser"

export function BrowserWorkbench({
  agentId,
  agentName,
  onClose,
}: {
  agentId: string
  agentName: string
  onClose: () => void
}) {
  const browser = useBrowser(agentId)
  const [wide, setWide] = useState(false)
  const [failedScreenshot, setFailedScreenshot] = useState<number | null>(null)
  const [url, setUrl] = useState("")
  const [settings, setSettings] = useState<{
    generation: number
    hosts: string
  } | null>(null)
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)")
    const update = () => setWide(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])
  const state = browser.state
  const content = (
    <>
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
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
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Hide browser"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
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
                {browser.busy ? "Opening…" : "Go"}
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
                {state.hasScreenshot && failedScreenshot !== state.version && (
                  <img
                    src={`${agentUrl(agentId, "browser/screenshot")}&version=${state.version}`}
                    onError={() => {
                      setFailedScreenshot(state.version)
                      void browser.refresh()
                    }}
                    alt={`Last captured view of ${state.page.title || state.page.url}`}
                    className="w-full rounded-md border bg-white"
                  />
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
                    variant="ghost"
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
  return wide ? (
    <aside
      className="browser-workbench flex min-h-0 w-[480px] shrink-0 flex-col border-l bg-background"
      aria-label={`${agentName} browser`}
    >
      {content}
    </aside>
  ) : (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <SheetContent
        showCloseButton={false}
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>{agentName} browser</SheetTitle>
          <SheetDescription>
            Inspect this bot’s Cloudflare browser and manage its allowed sites.
          </SheetDescription>
        </SheetHeader>
        {content}
      </SheetContent>
    </Sheet>
  )
}
