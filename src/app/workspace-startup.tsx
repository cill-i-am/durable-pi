import { AgentMark } from "@/components/agent-mark"
import { Skeleton } from "@/components/ui/skeleton"
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group"
import { useWorkspaceLocation } from "./use-workspace-location"

/** One public placeholder spans session, catalog and initial history. Shared
 * workspace classes reserve the same chrome at each breakpoint before admission. */
export function WorkspaceStartup() {
  const { pathname, search } = useWorkspaceLocation()
  return (
    <main
      id="main-content"
      tabIndex={-1}
      aria-busy="true"
      data-slot="workspace-startup"
      data-workbench={
        search.panel ? "open" : pathname === "/" ? "desktop-default" : "closed"
      }
      className="workspace-shell flex w-full motion-reduce:[&_[data-slot=skeleton]]:animate-none"
    >
      <div aria-hidden="true" className="workspace-bar">
        <div className="workspace-brand flex items-center gap-2 px-4">
          <AgentMark className="size-6 shrink-0" />
          <Skeleton className="h-4 w-28" />
        </div>
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-4 w-12" />
        <Skeleton className="workspace-search ms-auto" />
        <Skeleton className="size-6 shrink-0" />
      </div>
      <div aria-hidden="true" className="workspace-body">
        <aside className="workspace-startup-sidebar flex-col gap-4 bg-sidebar px-2.5 py-4">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="my-3 h-3 w-16" />
          {[0, 1, 2].map((item) => (
            <div key={item} className="flex h-[62px] items-center gap-2 px-2">
              <Skeleton className="size-[30px] shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Skeleton className="h-3 w-24 max-w-full" />
                <Skeleton className="h-2 w-full" />
              </div>
            </div>
          ))}
          <Skeleton className="mt-auto h-10 w-full" />
        </aside>
        <div className="workspace-main">
          <div className="agent-columns">
            <div className="chat-workspace">
              <div className="chat-header">
                <div className="chat-identity">
                  <Skeleton className="workspace-startup-sidebar-trigger" />
                  <AgentMark />
                  <div className="chat-identity-copy flex flex-1 flex-col gap-2">
                    <Skeleton className="h-4 w-32 max-w-full" />
                    <Skeleton className="h-3 w-40 max-w-full" />
                  </div>
                </div>
                <div className="chat-header-actions">
                  <Skeleton className="workspace-startup-action" />
                  <Skeleton className="workspace-startup-action" />
                </div>
              </div>
              <div className="conversation-scroller overflow-hidden">
                <div className="conversation-content flex h-full flex-col justify-end gap-8">
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
              </div>
              <div className="composer-area">
                <InputGroup className="chat-composer">
                  <div className="workspace-startup-composer-input">
                    <Skeleton className="h-4 w-40 max-w-full" />
                  </div>
                  <InputGroupAddon
                    align="block-end"
                    className="composer-controls"
                  >
                    <Skeleton className="composer-action shrink-0" />
                    <div className="composer-model">
                      <Skeleton className="h-4 w-32 max-w-full" />
                    </div>
                    <div className="composer-actions">
                      <Skeleton className="composer-action" />
                      <Skeleton className="composer-action" />
                    </div>
                  </InputGroupAddon>
                </InputGroup>
              </div>
            </div>
            <div className="workspace-startup-panel-backdrop" />
            <aside
              data-slot="startup-workbench"
              className="workbench-host workspace-startup-workbench"
              data-open="true"
            >
              <div className="workspace-startup-handle">
                <span />
              </div>
              <div className="workbench-header">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="ms-auto size-6" />
              </div>
              <div className="workbench-body">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-28 w-full" />
              </div>
              <StartupMobileNavigation />
            </aside>
          </div>
          <StartupMobileNavigation />
        </div>
      </div>
      <p role="status" className="sr-only">
        Opening your workspace…
      </p>
    </main>
  )
}

function StartupMobileNavigation() {
  return (
    <div className="mobile-navigation">
      {[0, 1, 2].map((item) => (
        <div
          key={item}
          className="flex h-[54px] flex-1 flex-col items-center justify-center gap-2"
        >
          <Skeleton className="size-[19px]" />
          <Skeleton className="h-2 w-12" />
        </div>
      ))}
    </div>
  )
}
