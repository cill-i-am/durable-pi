import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router"

import { ChatApp } from "@/app/workspace"
import { WorkspaceLinkError } from "@/app/workspace-link-error"

export const Route = createFileRoute("/_workspace")({
  component: WorkspaceLayout,
  errorComponent: WorkspaceLinkError,
})
function WorkspaceLayout() {
  const failed = useRouterState({
    select: (state) => state.matches.some((match) => match.status === "error"),
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
