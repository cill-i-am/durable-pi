import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router"

import { ChatApp } from "@/app/workspace"
import { WorkspaceLinkError } from "@/app/workspace-link-error"
import { workspaceNavigationContext } from "@/navigation/settings-stack"
import { reportClientError } from "@/observability/browser"

export const Route = createFileRoute("/_workspace")({
  beforeLoad: workspaceNavigationContext,
  component: WorkspaceLayout,
  errorComponent: WorkspaceLinkError,
  onCatch: (error, info?: { componentStack?: string | null }) => {
    void reportClientError(error, info)
  },
})
function WorkspaceLayout() {
  const failed = useRouterState({
    select: (state) =>
      state.matches.some(
        (match) => match.status === "error" || match.status === "notFound"
      ),
  })
  return failed ? (
    <Outlet />
  ) : (
    <>
      <ChatApp />
      <Outlet />
    </>
  )
}
