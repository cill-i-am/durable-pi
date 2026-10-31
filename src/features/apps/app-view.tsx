import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { DataLoading } from "@workspace/ui/components/data-loading"
import { ArrowLeft, ChevronDown, RefreshCw } from "lucide-react"
import { useEffect, useState } from "react"

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"

import { AppCanvas } from "./app-canvas"
import { useApp } from "./use-app"

import "./apps.css"

export function AppView(props: Parameters<typeof AppViewContent>[0]) {
  return <AppViewContent key={`${props.agentId}/${props.id}`} {...props} />
}
function AppViewContent({
  agentId,
  id,
  initialVersion,
  compact = false,
  onBack,
  onPendingChange,
  active = true,
}: {
  agentId: string
  id: string
  initialVersion?: number
  compact?: boolean
  onBack?: () => void
  onPendingChange?: (pending: boolean) => void
  active?: boolean
}) {
  const app = useApp(agentId, id)
  const busy = app.busy || !!app.attempt
  useEffect(() => {
    onPendingChange?.(app.busy || !!app.attempt)
    return () => onPendingChange?.(false)
  }, [app.busy, app.attempt, onPendingChange])
  const [selected, setSelected] = useState<number | null>(
    initialVersion ?? null
  )
  useEffect(() => {
    if (app.detail)
      setSelected(
        (current) =>
          current ?? app.detail!.app.publishedVersion ?? app.detail!.app.version
      )
  }, [app.detail])
  if (!app.detail)
    return (
      <div className="flex flex-col gap-3">
        {onBack && (
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            disabled={busy}
            onClick={onBack}
          >
            <ArrowLeft /> All apps
          </Button>
        )}
        {app.error ? (
          <Alert>
            <AlertDescription>
              {app.error}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void app.refresh()}
              >
                Retry app
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <DataLoading loading label="Loading app" layout="detail" />
        )}
      </div>
    )
  const { app: document, versions, events } = app.detail
  const version =
    versions.find(
      (value) =>
        value.version ===
        (selected ?? document.publishedVersion ?? document.version)
    ) ?? versions[0]!
  const published = version.version === document.publishedVersion
  const editable = published && !document.archived && !busy
  return (
    <section className="app-view" aria-label="Private app">
      <AppToolbar
        app={app}
        document={document}
        versions={versions}
        version={version}
        published={published}
        onBack={onBack}
        setSelected={setSelected}
        active={active}
      />
      {app.error && (
        <Alert>
          <AlertDescription>{app.error}</AlertDescription>
        </Alert>
      )}
      {app.attempt && !app.busy && (
        <Alert>
          <AlertDescription>
            The change is unconfirmed. Retry keeps the same request.
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={app.busy}
                onClick={() => void app.retry()}
              >
                Retry change
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={app.busy}
                onClick={() => void app.cancel()}
              >
                Resolve and edit
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      {document.publishedVersion !== null &&
        version.version !== document.publishedVersion && (
          <Alert>
            <AlertDescription>
              Version {document.publishedVersion} is currently published. Your
              preview stays on version {version.version}; use the version menu
              when you are ready to switch.
            </AlertDescription>
          </Alert>
        )}
      <AppCanvas
        key={`${id}-${version.version}`}
        definition={version.definition}
        agentId={agentId}
        id={id}
        version={version.version}
        revision={document.revision}
        state={published ? document.state : { checks: {}, forms: {} }}
        disabled={!editable || !active}
        onAction={(action, expectedRevision) =>
          active
            ? app.mutate("apps/interact", {
                id,
                version: version.version,
                expectedRevision: expectedRevision ?? document.revision,
                action,
              })
            : Promise.resolve(false)
        }
      />
      <AppPublication
        app={app}
        document={document}
        version={version}
        published={published}
        id={id}
      />
      {!compact && (
        <>
          <details>
            <summary className="cursor-pointer text-xs font-medium">
              Recent app updates ({events.length})
            </summary>
            <ul className="mt-3 flex flex-col gap-3">
              {events.map((event) => (
                <li key={event.id} className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">
                    {new Date(event.createdAt).toLocaleString()} ·{" "}
                    {event.delivery === "queued"
                      ? "Sent to conversation"
                      : event.delivery === "cancelled"
                        ? "Cancelled"
                        : event.delivery === "exhausted"
                          ? "Delivery stopped"
                          : "Waiting for bot"}
                  </span>
                  {event.deliveryMessage && <p>{event.deliveryMessage}</p>}
                  <p className="max-h-28 overflow-auto break-words whitespace-pre-wrap">
                    {event.text}
                  </p>
                </li>
              ))}
            </ul>
          </details>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              void app.mutate("apps/archive", {
                id,
                expectedRevision: document.revision,
                archived: !document.archived,
              })
            }
          >
            {document.archived ? "Restore app" : "Archive app"}
          </Button>
        </>
      )}
    </section>
  )
}

function AppToolbar({
  app,
  document,
  versions,
  version,
  published,
  onBack,
  setSelected,
  active,
}: {
  app: ReturnType<typeof useApp>
  document: NonNullable<ReturnType<typeof useApp>["detail"]>["app"]
  versions: NonNullable<ReturnType<typeof useApp>["detail"]>["versions"]
  version: NonNullable<ReturnType<typeof useApp>["detail"]>["versions"][number]
  published: boolean
  onBack?: () => void
  setSelected: (version: number) => void
  active: boolean
}) {
  return (
    <div className="app-view-toolbar">
      {onBack && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="All apps"
          disabled={app.busy || !!app.attempt}
          onClick={onBack}
        >
          <ArrowLeft />
        </Button>
      )}
      <Badge variant="secondary">
        {document.archived
          ? "Archived"
          : published
            ? "Published"
            : "Version preview"}
      </Badge>
      <DropdownMenu key={active ? "active" : "inactive"}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="xs"
              disabled={app.busy || !!app.attempt}
            />
          }
        >
          Version {version.version}
          <ChevronDown data-icon="inline-end" />
        </DropdownMenuTrigger>
        {active && (
          <DropdownMenuContent>
            <DropdownMenuGroup>
              {versions.map((value) => (
                <DropdownMenuItem
                  key={value.version}
                  onClick={() => setSelected(value.version)}
                >
                  Version {value.version}
                  {value.version === document.publishedVersion
                    ? " · published"
                    : ""}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        )}
      </DropdownMenu>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Refresh app"
        disabled={app.busy}
        onClick={() => void app.refresh()}
      >
        <RefreshCw />
      </Button>
    </div>
  )
}

function AppPublication({
  app,
  document,
  version,
  published,
  id,
}: Pick<
  Parameters<typeof AppToolbar>[0],
  "app" | "document" | "version" | "published"
> & { id: string }) {
  const busy = app.busy || !!app.attempt
  const pending = app.detail!.events.filter(
    (event) => event.delivery === "pending"
  ).length
  return (
    <>
      {!published && !document.archived && (
        <Button
          disabled={busy}
          onClick={() =>
            void app.mutate("apps/publish", {
              id,
              version: version.version,
              expectedRevision: document.revision,
            })
          }
        >
          Publish version {version.version}
        </Button>
      )}
      {(document.archived || !published) && (
        <p className="text-xs text-muted-foreground">
          {document.archived
            ? "Restore this app to use it."
            : "Preview only. Publish this version to use its controls."}
        </p>
      )}
      {pending > 0 && (
        <p className="text-xs text-muted-foreground" role="status">
          {pending} {pending === 1 ? "update is" : "updates are"} waiting for
          the bot. They will be queued when its model connection is available.
        </p>
      )}
    </>
  )
}
