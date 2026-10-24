import "@/styles.css"
import {
  createRootRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router"
import React, { useState } from "react"
import { createRoot } from "react-dom/client"

import { WorkspaceLinkError } from "@/app/workspace-link-error.tsx"
import { WorkspaceNavigation } from "@/app/workspace-navigation.tsx"
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
  const [show, setShow] = useState(true),
    [locked, setLocked] = useState(false),
    [failure, setFailure] = useState(error)
  fixture.replace = () => setFailure(new Error("replacement route error"))
  fixture.unmount = () => setShow(false)
  fixture.lock = (v) => setLocked(v)
  return new URLSearchParams(location.search).has("search") ? (
    <WorkspaceNavigation
      name="Tester"
      agents={agents}
      selected={agents[0]}
      locked={locked}
      workbench="files"
      onSelect={(id) => fixture.selected.push(id)}
      onAction={(action) => fixture.actions.push(action)}
    />
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
  <RouterProvider router={router} />
)
