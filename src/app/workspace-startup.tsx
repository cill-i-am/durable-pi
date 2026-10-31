import { Skeleton } from "@workspace/ui/components/skeleton"

/** Reserve final geometry while session, catalog and initial history load.
 * No private content enters this public placeholder. */
export function WorkspaceStartup() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      aria-busy="true"
      data-slot="workspace-startup"
      className="workspace-shell motion-reduce:[&_[data-slot=skeleton]]:animate-none"
    >
      <span role="status" className="sr-only">
        Opening workspace…
      </span>
      <aside aria-hidden="true" className="workspace-startup-sidebar">
        <Skeleton className="h-6 w-32" />
        <div className="flex flex-col gap-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} className="h-9 w-full" />
          ))}
        </div>
        <Skeleton className="mt-auto h-8 w-full" />
      </aside>
      <div aria-hidden="true" className="workspace-main">
        <div className="workspace-startup-header">
          <Skeleton className="size-6" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="workspace-startup-history">
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-3 w-3/5" />
          <Skeleton className="h-3 w-2/3" />
        </div>
        <div className="workspace-startup-composer" />
      </div>
    </main>
  )
}
