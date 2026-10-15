import { createRoot } from "react-dom/client"
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { ThemeProvider } from "next-themes"
import { ChatApp } from "../../src/app/workspace"
import "../../src/styles.css"

// The actual workspace, with only its transport and route shell replaced.
// No Cloudflare credentials or real provider/tool calls enter this fixture.
const root = createRootRoute({ component: ChatApp })
const paths = [
  "/agents",
  "/agents/archived",
  "/agents/$agentId",
  "/agents/$agentId/$panel",
  "/agents/$agentId/$panel/$itemId",
] as const
const router = createRouter({
  routeTree: root.addChildren(
    paths.map((path) => createRoute({ getParentRoute: () => root, path }))
  ),
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
createRoot(document.getElementById("root")!).render(
  <ThemeProvider attribute="class">
    <RouterProvider router={router} />
  </ThemeProvider>
)
