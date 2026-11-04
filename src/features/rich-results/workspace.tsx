import { Button } from "@workspace/ui/components/button"
import { ArrowUpRight } from "lucide-react"
import { useContext, type ReactNode } from "react"

import { resultReference } from "@/navigation/result-reference"

import {
  ResultElementContext,
  ResultSourceContext,
  ResultWorkspaceContext,
} from "./result-workspace-context"

/** A retained result tab owns the only full editing surface. */
export function AnswerWorkspace({
  title,
  description,
  sidebar,
  toolbar,
  children,
}: {
  title: string
  description: string
  sidebar?: ReactNode
  toolbar?: ReactNode
  children: ReactNode
}) {
  const workspace = useContext(ResultWorkspaceContext)
  const identity = useContext(ResultElementContext)
  const source = useContext(ResultSourceContext)
  const reference = identity ? resultReference(identity) : null
  const promoted = !!reference && !!workspace?.opened.includes(reference)
  const ownsSurface =
    source?.surface === "workbench" && source.reference === reference
  const compact = promoted && !ownsSurface
  return (
    <div className="answer-workspace flex min-w-0 flex-col gap-4">
      {compact ? (
        <div className="answer-workspace-source">
          <p className="font-medium">{title}</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => workspace?.open(reference!)}
          >
            View in workbench <ArrowUpRight data-icon="inline-end" />
          </Button>
        </div>
      ) : (
        <>
          {toolbar && (
            <div className="flex flex-wrap items-center gap-2">{toolbar}</div>
          )}
          <div
            className={
              ownsSurface && sidebar
                ? "grid min-w-0 gap-6 @3xl:grid-cols-[16rem_minmax(0,1fr)]"
                : "min-w-0"
            }
          >
            {ownsSurface && sidebar && (
              <aside className="flex min-w-0 flex-col gap-5 rounded-lg bg-muted/40 p-5">
                {sidebar}
              </aside>
            )}
            <div className="@container min-w-0">{children}</div>
          </div>
          {workspace && reference && source?.surface !== "workbench" && (
            <Button
              variant="ghost"
              size="sm"
              className="self-end"
              aria-description={description}
              onClick={() => workspace.open(reference)}
            >
              Open in workbench <ArrowUpRight data-icon="inline-end" />
            </Button>
          )}
        </>
      )}
    </div>
  )
}
