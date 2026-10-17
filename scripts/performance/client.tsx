import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
} from "@tanstack/react-router"
import { ThemeProvider } from "next-themes"
import { useState } from "react"
import { createRoot } from "react-dom/client"

import { ChatApp } from "../../src/app/workspace"
import {
  ActivityBorder,
  ActivityOrb,
} from "../../src/components/activity-visuals"
import { Button } from "../../src/components/ui/button"
import {
  InputGroup,
  InputGroupTextarea,
} from "../../src/components/ui/input-group"
import { JoinFamily } from "../../src/features/family/join"

import "./styles.css"

// The actual workspace, with only its transport and route shell replaced.
// No Cloudflare credentials or real provider/tool calls enter this fixture.
const root = createRootRoute({ component: Outlet })
const paths = [
  "/",
  "/agents",
  "/agents/archived",
  "/agents/$agentId",
  "/agents/$agentId/settings/$section",
  "/agents/$agentId/$panel",
  "/agents/$agentId/$panel/$itemId",
] as const
const router = createRouter({
  routeTree: root.addChildren([
    ...paths.map((path) =>
      createRoute({ getParentRoute: () => root, path, component: ChatApp })
    ),
    createRoute({
      getParentRoute: () => root,
      path: "/join",
      component: JoinFamily,
    }),
  ]),
})
const observe = new MutationObserver(() => {
  for (const [stage, selector] of [
    ["history", 'button[aria-label="Copy response"]'],
    ["composer", "textarea:not(:disabled)"],
  ] as const) {
    const name = `bench:${stage}:ready`
    if (
      document.querySelector(selector) &&
      !performance.getEntriesByName(name).length
    )
      performance.mark(name)
  }
})
observe.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["disabled"],
})
function VisualsFixture() {
  const [active, setActive] = useState(false)
  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <Button
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => setActive((value) => !value)}
      >
        Toggle activity
      </Button>
      <ActivityBorder active={active}>
        <InputGroup className="chat-composer">
          <InputGroupTextarea
            aria-label="Synthetic draft"
            placeholder="A synthetic draft"
          />
        </InputGroup>
      </ActivityBorder>
      {active && <ActivityOrb />}
    </main>
  )
}

createRoot(document.getElementById("root")!).render(
  <ThemeProvider attribute="class">
    {window.location.pathname === "/__visuals" ? (
      <VisualsFixture />
    ) : (
      <RouterProvider router={router} />
    )}
  </ThemeProvider>
)
