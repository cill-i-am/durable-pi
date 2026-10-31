import { Link } from "@tanstack/react-router"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@workspace/ui/components/empty"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { ChevronRight } from "lucide-react"
import { useEffect, useState } from "react"

import { type AppDocument } from "@/apps/contracts"
import { parseAgentId, workspaceDestination } from "@/navigation/workspace"

import { AppView } from "./app-view"
import { useAppList } from "./use-app-list"

import "./apps.css"

export function AppsWorkbench(props: Parameters<typeof AppsWorkbenchView>[0]) {
  return <AppsWorkbenchView key={props.agentId} {...props} />
}
function AppsWorkbenchView({
  agentId,
  onPendingChange,
  selected,
  onSelect: setSelected,
  active = true,
}: {
  selected: string | null
  onSelect: (id: string | null) => void
  agentId: string
  onPendingChange: (pending: boolean) => void
  active?: boolean
}) {
  const { apps, error, loading, refresh } = useAppList(agentId)
  const [interactionPending, setInteractionPending] = useState(false)
  useEffect(() => {
    onPendingChange(interactionPending)
    return () => onPendingChange(false)
  }, [interactionPending, onPendingChange])
  const content = (
    <section className="apps-surface">
      {!selected && (
        <header className="workbench-heading-row">
          <h2 className="workbench-section-title">Apps</h2>
        </header>
      )}
      <div className="workbench-body apps-workbench-body">
        {error && (
          <Alert>
            <AlertDescription>
              {error}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refresh()}
              >
                Retry apps
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {selected ? (
          <AppView
            key={selected}
            agentId={agentId}
            id={selected}
            onBack={() => setSelected(null)}
            onPendingChange={setInteractionPending}
            active={active}
          />
        ) : (
          <>
            {loading && <Skeleton className="h-24 w-full" />}
            {!loading && !apps.length && !error && (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No apps yet</EmptyTitle>
                  <EmptyDescription>
                    Ask your assistant to build an app.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            {apps
              .filter((app) => !app.archived)
              .map((app) => (
                <AppRow key={app.id} app={app} agentId={agentId} />
              ))}
            {apps.some((app) => app.archived) && (
              <details>
                <summary className="cursor-pointer text-xs font-medium">
                  Archived apps
                </summary>
                <div className="mt-3 flex flex-col gap-2">
                  {apps
                    .filter((app) => app.archived)
                    .map((app) => (
                      <AppRow key={app.id} app={app} agentId={agentId} />
                    ))}
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </section>
  )
  return content
}

function AppRow({ app, agentId }: { app: AppDocument; agentId: string }) {
  return (
    <Link
      data-slot="button"
      {...workspaceDestination(parseAgentId(agentId), {
        panel: "apps",
        item: app.id,
      })}
      className={buttonVariants({
        variant: "ghost",
        className: "app-list-row",
      })}
    >
      <span className="app-list-identity">
        <span className="font-medium break-words">{app.definition.title}</span>
        <span className="text-xs text-muted-foreground">
          {app.archived
            ? "Archived"
            : app.publishedVersion
              ? `Published · version ${app.publishedVersion}`
              : "Draft"}
        </span>
      </span>
      <ChevronRight className="text-muted-foreground" />
    </Link>
  )
}
