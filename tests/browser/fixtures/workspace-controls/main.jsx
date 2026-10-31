import "./styles.css"
import "@/app/workspace.css"
import {
  createRootRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router"
import { TooltipProvider } from "@workspace/ui/components/tooltip"
import React, { useState } from "react"
import { createRoot } from "react-dom/client"

import { WorkspaceLinkError } from "@/app/workspace-link-error.tsx"
import { WorkspaceNavigation } from "@/app/workspace-navigation.tsx"
import {
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
const fixture = { calls: 0, resets: 0, selected: [], actions: [], pending: [] }
window.fixture = fixture
const error = new Error("held router loader")
const agents = [
  {
    id: "home",
    slug: "home",
    name: "Home",
    instructions: "",
    status: "active",
    revision: 1,
    createdAt: "today",
    updatedAt: "today",
  },
  {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "second",
    name: "Second",
    instructions: "",
    status: "active",
    revision: 1,
    createdAt: "today",
    updatedAt: "today",
  },
]
function App() {
  const { isMobile } = useSidebar()
  const [show, setShow] = useState(true),
    [locked, setLocked] = useState(false),
    [failure, setFailure] = useState(error)
  fixture.replace = () => setFailure(new Error("replacement route error"))
  fixture.unmount = () => setShow(false)
  fixture.lock = (v) => setLocked(v)
  return new URLSearchParams(location.search).has("search") ? (
    <>
      <WorkspaceNavigation
        name="Tester"
        agents={agents}
        selected={agents[0]}
        locked={locked}
        collection={false}
        statuses={{ home: { state: "ready", turnId: null } }}
        onSettings={(category) => fixture.actions.push(category)}
        onCollection={() => fixture.actions.push("collection")}
        onAgentSettings={() => fixture.actions.push("assistant-settings")}
        onEdit={() => fixture.actions.push("edit")}
        onArchive={() => fixture.actions.push("archive")}
        onSelect={(id) => fixture.selected.push(id)}
        onAction={(action) => fixture.actions.push(action)}
      />
      <main
        className="workspace-main"
        data-sidebar-mobile={isMobile}
        tabIndex={-1}
      >
        <SidebarTrigger />
        <h1>Workspace controls</h1>
      </main>
    </>
  ) : show ? (
    <WorkspaceLinkError error={failure} reset={() => fixture.resets++} />
  ) : (
    <p>Retired</p>
  )
}
const route = createRootRoute({ component: App }),
  router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
router.invalidate = () => {
  fixture.calls++
  return new Promise((resolve, reject) =>
    fixture.pending.push({ resolve, reject })
  )
}
createRoot(document.getElementById("root")).render(
  <TooltipProvider>
    <SidebarProvider
      className="workspace-shell"
      style={{ "--sidebar-width": "var(--workspace-sidebar-width)" }}
    >
      <RouterProvider router={router} />
    </SidebarProvider>
  </TooltipProvider>
)
