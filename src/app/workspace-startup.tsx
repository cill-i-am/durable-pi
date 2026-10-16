import { AgentMark } from "@/components/agent-mark"
import { Skeleton } from "@/components/ui/skeleton"

/** The same public placeholder spans session, catalog and initial history.
 * It contains no account data or interactive chat controls. */
export function WorkspaceStartup() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      aria-busy="true"
      data-slot="workspace-startup"
      className="flex h-svh flex-col overflow-hidden motion-reduce:[&_[data-slot=skeleton]]:animate-none"
    >
      <div aria-hidden="true" className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-[68px] shrink-0 items-center gap-3 border-b px-6">
          <AgentMark className="pi-mark" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="mx-auto flex min-h-0 w-full max-w-[850px] flex-1 flex-col gap-8 px-6 py-8">
          <div className="flex w-2/3 flex-col gap-3 self-end">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3 self-end" />
          </div>
          <div className="flex w-4/5 flex-col gap-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </div>
        <div className="mx-auto w-full max-w-[850px] shrink-0 p-6">
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      </div>
      <p role="status" className="sr-only">
        Opening your workspace…
      </p>
    </main>
  )
}
