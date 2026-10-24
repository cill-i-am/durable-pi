import { Link } from "@tanstack/react-router"
import { PanelsTopLeft, ListTodo } from "lucide-react"
import { useEffect, useState } from "react"

import { type AppDocument } from "@/apps/contracts"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { parseAgentId, workspaceDestination } from "@/navigation/workspace"

import { AppView } from "./app-view"
import { useAppList } from "./use-app-list"

export function AppsWorkbench(props: Parameters<typeof AppsWorkbenchView>[0]) {
  return <AppsWorkbenchView key={props.agentId} {...props} />
}
function AppsWorkbenchView({
  agentId,
  onPendingChange,
  selected,
  onSelect: setSelected,
}: {
  selected: string | null
  onSelect: (id: string | null) => void
  agentId: string
  onPendingChange: (pending: boolean) => void
}) {
  const { apps, error, loading, refresh } = useAppList(agentId)
  const [interactionPending, setInteractionPending] = useState(false)
  useEffect(() => {
    onPendingChange(interactionPending)
    return () => onPendingChange(false)
  }, [interactionPending, onPendingChange])
  const content = (
    <>
      {!selected && (
        <header className="workbench-heading-row">
          <div className="flex items-center gap-2 text-sm font-medium">
            <PanelsTopLeft className="size-4" />
            <h2 className="workbench-section-title">Apps</h2>
          </div>
          <Link
            {...workspaceDestination(parseAgentId(agentId), {
              panel: "objects",
            })}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <ListTodo /> Checklists
          </Link>
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
          />
        ) : (
          <>
            {loading && <Skeleton className="h-24 w-full" />}
            {!loading && !apps.length && !error && (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No apps yet</EmptyTitle>
                  <EmptyDescription>
                    Ask your agent to build an app.
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
    </>
  )
  return content
}

function AppRow({ app, agentId }: { app: AppDocument; agentId: string }) {
  return (
    <Link
      {...workspaceDestination(parseAgentId(agentId), {
        panel: "apps",
        item: app.id,
      })}
      className={buttonVariants({
        variant: "ghost",
        className: "app-list-row",
      })}
    >
      <span className="max-w-full truncate font-medium">
        {app.definition.title}
      </span>
      <span className="text-xs text-muted-foreground">
        {app.archived
          ? "Archived"
          : app.publishedVersion
            ? `Published · version ${app.publishedVersion}`
            : "Draft"}
      </span>
    </Link>
  )
}
