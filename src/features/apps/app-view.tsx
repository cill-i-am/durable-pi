import { useEffect, useState } from "react"
import { AppCanvas } from "./app-canvas"
import { useApp } from "./use-app"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { ChevronDown } from "lucide-react"

export function AppView({
  agentId,
  id,
  initialVersion,
  compact = false,
}: {
  agentId: string
  id: string
  initialVersion?: number
  compact?: boolean
}) {
  const app = useApp(agentId, id)
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
          <Skeleton className="h-32 w-full" />
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
  const editable = published && !document.archived && !app.busy && !app.attempt
  const pending = events.filter((event) => event.delivery === "pending").length
  return (
    <section className="flex min-w-0 flex-col gap-4" aria-label="Private app">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">
          {document.archived
            ? "Archived"
            : published
              ? "Published privately"
              : "Version preview"}
        </Badge>
        <DropdownMenu>
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
        </DropdownMenu>
        <Button
          variant="ghost"
          size="xs"
          disabled={app.busy}
          onClick={() => void app.refresh()}
        >
          Refresh app
        </Button>
      </div>
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
        revision={document.revision}
        state={published ? document.state : { checks: {}, forms: {} }}
        disabled={!editable}
        onAction={(action, expectedRevision) =>
          app.mutate("apps/interact", {
            id,
            version: version.version,
            expectedRevision: expectedRevision ?? document.revision,
            action,
          })
        }
      />
      {!published && !document.archived && (
        <Button
          disabled={app.busy || !!app.attempt}
          onClick={() =>
            void app.mutate("apps/publish", {
              id,
              version: version.version,
              expectedRevision: document.revision,
            })
          }
        >
          Publish version {version.version} privately
        </Button>
      )}
      <p className="text-xs text-muted-foreground">
        {document.archived
          ? "Restore this app to use it."
          : published
            ? "Changes are saved privately and send an update to this bot. Its tool approval settings still apply."
            : "Preview only. Publish this version to use its controls."}
      </p>
      {pending > 0 && (
        <p className="text-xs text-muted-foreground" role="status">
          {pending} {pending === 1 ? "update is" : "updates are"} waiting for
          the bot. They will be queued when its model connection is available.
        </p>
      )}
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
                      : "Waiting for bot"}
                  </span>
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
            disabled={app.busy || !!app.attempt}
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
