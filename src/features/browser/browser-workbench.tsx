import { Alert, AlertDescription } from "@workspace/ui/components/alert"

import "./browser.css"
import { Badge } from "@workspace/ui/components/badge"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { DataLoading } from "@workspace/ui/components/data-loading"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  FieldContent,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Switch } from "@workspace/ui/components/switch"
import { Textarea } from "@workspace/ui/components/textarea"
import { ArrowUpRight, Globe, RefreshCw, Settings2, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { BrowserControls } from "./browser-controls"
import { BrowserScreenshot } from "./browser-preview"
import { useBrowser } from "./use-browser"

export function BrowserWorkbench({
  agentId,
  agentName,
  onPendingChange,
}: {
  agentId: string
  agentName: string
  onPendingChange: (pending: boolean) => void
}) {
  const browser = useBrowser(agentId)
  const [url, setUrl] = useState("")
  const [settings, setSettings] = useState<BrowserSettings | null>(null)
  const settingsTrigger = useRef<HTMLButtonElement>(null)
  const wasEditing = useRef(false)
  useEffect(() => {
    if (wasEditing.current && !settings) settingsTrigger.current?.focus()
    wasEditing.current = !!settings
  }, [settings])
  useEffect(() => {
    onPendingChange(browser.busy || !!settings)
    return () => onPendingChange(false)
  }, [browser.busy, settings, onPendingChange])
  const state = browser.state
  const content = (
    <section className="browser-workbench @container/tool flex min-h-0 min-w-0 flex-1 flex-col">
      <BrowserHeader
        browser={browser}
        agentName={agentName}
        settings={settings}
        setSettings={setSettings}
        settingsTrigger={settingsTrigger}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain p-5 @max-md/tool:p-4">
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
        <DataLoading
          loading={!state && !browser.error}
          label="Loading browser"
          layout="media"
        >
          {settings ? (
            <BrowserInternetSettings
              browser={browser}
              agentName={agentName}
              settings={settings}
              setSettings={setSettings}
            />
          ) : (
            <>
              <BrowserAddress
                browser={browser}
                url={url}
                setUrl={setUrl}
                setSettings={setSettings}
              />
              {state?.page && (
                <BrowserPreview
                  browser={browser}
                  state={state}
                  page={state.page}
                  agentId={agentId}
                  setUrl={setUrl}
                />
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
        </DataLoading>
      </div>
      <details className="shrink-0 border-t px-5 py-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer">Session limits</summary>
        <p className="mt-2 max-w-prose leading-relaxed">
          Sessions expire after two idle minutes or ten minutes total. Hiding
          this panel leaves the session running until it expires.
        </p>
      </details>
    </section>
  )
  return content
}

type BrowserModel = ReturnType<typeof useBrowser>
type BrowserSettings = {
  generation: number
  hosts: string
  unrestricted: boolean
}

function BrowserHeader({
  browser,
  agentName,
  settings,
  setSettings,
  settingsTrigger,
}: {
  browser: BrowserModel
  agentName: string
  settings: BrowserSettings | null
  setSettings: (value: BrowserSettings | null) => void
  settingsTrigger: React.Ref<HTMLButtonElement>
}) {
  const state = browser.state
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-4 @max-md/tool:px-4">
      <h2 className="min-w-0 text-md font-semibold wrap-anywhere">
        {settings ? "Browser internet access" : "Browser"}
      </h2>
      <div className="flex shrink-0 items-center gap-2">
        {!settings && (
          <Badge variant="secondary">{state?.status ?? "Loading"}</Badge>
        )}
        {!settings && state?.expiresAt && state.status !== "expired" && (
          <Button
            size="sm"
            variant="outline"
            disabled={browser.busy}
            onClick={() =>
              void browser.command("control", {
                generation: state.policy.generation,
                controller: state.controller === "owner" ? "agent" : "owner",
              })
            }
          >
            {state.controller === "owner"
              ? `Hand back to ${agentName}`
              : "Take control"}
          </Button>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          ref={settingsTrigger}
          aria-label={
            settings ? "Close browser settings" : "Browser internet settings"
          }
          disabled={!state || browser.busy}
          onClick={() =>
            setSettings(
              settings
                ? null
                : {
                    generation: state!.policy.generation,
                    hosts: state!.policy.hosts.join("\n"),
                    unrestricted: state!.policy.unrestricted ?? false,
                  }
            )
          }
        >
          {settings ? <X /> : <Settings2 />}
        </Button>
      </div>
    </div>
  )
}

function BrowserInternetSettings({
  browser,
  agentName,
  settings,
  setSettings,
}: {
  browser: BrowserModel
  agentName: string
  settings: BrowserSettings
  setSettings: (value: BrowserSettings | null) => void
}) {
  const state = browser.state
  return (
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
            unrestricted: settings.unrestricted,
          })
        )
          setSettings(null)
      }}
    >
      <FieldGroup>
        <Field orientation="horizontal" data-disabled={browser.busy}>
          <FieldContent>
            <FieldLabel htmlFor="browser-internet">
              Unrestricted internet access
            </FieldLabel>
            <FieldDescription>
              Visit public HTTP and HTTPS sites without an allowed-site list.
              Browser tool permissions still apply.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="browser-internet"
            checked={settings.unrestricted}
            disabled={browser.busy}
            onCheckedChange={(unrestricted) =>
              setSettings({ ...settings, unrestricted })
            }
          />
        </Field>
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
            disabled={browser.busy || settings.unrestricted}
          />
        </Field>
        <p className="text-xs text-muted-foreground">
          Up to 20 exact hostnames, one per line. Subdomains must be listed
          separately. Cloudflare’s common CDN set is allowed for page assets.
          This list applies when unrestricted access is off. Changing settings
          closes this session and clears its preview.
        </p>
        {state && settings.generation !== state.policy.generation && (
          <p className="text-sm text-destructive">
            Settings changed elsewhere. Cancel and reopen settings to review
            them.
          </p>
        )}
        <div className="flex gap-2">
          <Button
            type="submit"
            size="sm"
            disabled={
              browser.busy || settings.generation !== state?.policy.generation
            }
          >
            Save internet settings
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
  )
}

function BrowserAddress({
  browser,
  url,
  setUrl,
  setSettings,
}: {
  browser: BrowserModel
  url: string
  setUrl: (url: string) => void
  setSettings: (settings: BrowserSettings) => void
}) {
  const state = browser.state
  return (
    <>
      <form
        className="browser-address-bar"
        onSubmit={(event) => {
          event.preventDefault()
          if (state)
            void browser.command("open", {
              generation: state.policy.generation,
              url,
            })
        }}
      >
        <Globe className="size-4 shrink-0 text-muted-foreground" />
        <Input
          aria-label="Browser URL"
          type="url"
          placeholder={state?.page?.url ?? "https://example.com"}
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
            browser.busy ||
            !state ||
            !url ||
            (!state.policy.unrestricted && !state.policy.hosts.length)
          }
        >
          {browser.pending === "open" ? "Opening…" : "Go"}
        </Button>
      </form>
      {state && !state.policy.unrestricted && !state.policy.hosts.length && (
        <div className="flex flex-col items-start gap-3 rounded-lg border p-5">
          <Globe className="size-6 text-muted-foreground" />
          <h3 className="font-medium">Choose where to browse</h3>
          <p className="text-sm text-muted-foreground">
            Allow sites or enable internet access. Tool approvals still apply.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setSettings({
                generation: state.policy.generation,
                hosts: "",
                unrestricted: false,
              })
            }
          >
            Set internet access
          </Button>
        </div>
      )}
    </>
  )
}

function BrowserPreview({
  browser,
  state,
  page,
  agentId,
  setUrl,
}: {
  browser: BrowserModel
  state: NonNullable<BrowserModel["state"]>
  page: NonNullable<NonNullable<BrowserModel["state"]>["page"]>
  agentId: string
  setUrl: (url: string) => void
}) {
  return (
    <section className="browser-preview">
      <div className="browser-preview-heading">
        <div className="min-w-0">
          <h3 className="text-sm font-medium break-words">
            {page.title || "Browser page"}
          </h3>
        </div>
        <a
          href={page.url}
          target="_blank"
          rel="noopener noreferrer"
          data-slot="button"
          className={buttonVariants({
            variant: "ghost",
            size: "icon-sm",
          })}
          aria-label="Open page in your browser"
        >
          <ArrowUpRight />
        </a>
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
        <BrowserScreenshot
          agentId={agentId}
          state={state}
          refresh={() => void browser.refresh()}
          alt={`Last captured view of ${page.title || page.url}`}
        />
      )}
      <p className="text-xs text-muted-foreground">
        Captured{" "}
        {new Date(page.capturedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}
        · Snapshot
      </p>
      <details className="browser-page-detail">
        <summary className="cursor-pointer text-sm">
          Page text · {page.text.length.toLocaleString()} characters
        </summary>
        <pre className="mt-3 text-xs break-words whitespace-pre-wrap">
          {page.text || "No readable text was found."}
        </pre>
      </details>
      {!!page.links.length && (
        <details className="browser-page-detail">
          <summary className="cursor-pointer text-sm">
            Page links · {page.links.length}
          </summary>
          <ul className="mt-3 flex flex-col gap-2">
            {page.links.map((link, index) => (
              <li key={index}>
                <button
                  type="button"
                  className="max-w-full text-left text-sm break-words text-primary underline underline-offset-2"
                  onClick={() => setUrl(link.url)}
                >
                  {link.text}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
