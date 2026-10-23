import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
  useRouterState,
} from "@tanstack/react-router"
import { ThemeProvider } from "next-themes"
import { useState } from "react"
import { createRoot } from "react-dom/client"

import { ChatApp } from "../../src/app/workspace"
import { WorkspaceLinkError } from "../../src/app/workspace-link-error"
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
import { UpdateRecovery } from "../../src/features/updates/update-recovery"
import { workspaceView } from "../../src/navigation/workspace"
import { reportClientError } from "../../src/observability/browser"
import { Route as PanelRoute } from "../../src/routes/_workspace.agents.$agentId.$panel.index"
import { Route as SettingsRoute } from "../../src/routes/_workspace.agents.$agentId.settings.$section"
import { Route as FamilyRoute } from "../../src/routes/_workspace.family"
import { Route as ModelAccessRoute } from "../../src/routes/_workspace.family.model-access"
import { Route as SecurityRoute } from "../../src/routes/_workspace.settings.security"

import "./styles.css"

// The actual workspace, with only its transport and route shell replaced.
// No Cloudflare credentials or real provider/tool calls enter this fixture.
const root = createRootRoute({
  component: Outlet,
  notFoundComponent: () => <h1>Page not found</h1>,
})
const workspace = createRoute({
  getParentRoute: () => root,
  id: "_workspace",
  errorComponent: WorkspaceLinkError,
  component: FixtureWorkspace,
})
const paths = [
  "/",
  "/agents",
  "/agents/archived",
  "/agents/$agentId",
  "/agents/$agentId/$panel/$itemId",
] as const
const router = createRouter({
  defaultOnCatch: (error, info?: { componentStack?: string | null }) => {
    void reportClientError(error, info)
  },
  routeTree: root.addChildren([
    workspace.addChildren([
      ...paths.map((path) =>
        createRoute({
          getParentRoute: () => workspace,
          path,
          component: () => null,
        })
      ),
      createRoute({
        validateSearch: FamilyRoute.options.validateSearch,
        component: FamilyRoute.options.component,
        getParentRoute: () => workspace,
        path: "/family",
      }),
      createRoute({
        validateSearch: ModelAccessRoute.options.validateSearch,
        component: ModelAccessRoute.options.component,
        getParentRoute: () => workspace,
        path: "/family/model-access",
      }),
      createRoute({
        validateSearch: SecurityRoute.options.validateSearch,
        component: SecurityRoute.options.component,
        getParentRoute: () => workspace,
        path: "/settings/security",
      }),
      createRoute({
        params: PanelRoute.options.params,
        validateSearch: PanelRoute.options.validateSearch,
        beforeLoad: ({ params, search }) => {
          workspaceView(params, search)
        },
        getParentRoute: () => workspace,
        path: "/agents/$agentId/$panel",
        component: () => null,
      }),
      createRoute({
        params: SettingsRoute.options.params,
        validateSearch: SettingsRoute.options.validateSearch,
        beforeLoad: ({ params, search }) => {
          workspaceView(params, search)
        },
        component: SettingsRoute.options.component,
        getParentRoute: () => workspace,
        path: "/agents/$agentId/settings/$section",
      }),
    ]),
    createRoute({
      getParentRoute: () => root,
      path: "/__client-error",
      errorComponent: WorkspaceLinkError,
      component: ClientErrorFixture,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/join",
      component: JoinFamily,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/__route-recovery",
      loader: async () => {
        const response = await fetch("/api/fixture/route-ready")
        if (!response.ok) throw new Error("Synthetic workspace load failure")
      },
      errorComponent: WorkspaceLinkError,
      component: ChatApp,
    }),
  ]),
})
function FixtureWorkspace() {
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
function ClientErrorFixture() {
  const [failed, setFailed] = useState(false)
  if (failed)
    throw new TypeError(
      "Cannot read properties of undefined (reading 'PRIVATE_CHAT_CONTENT')",
      { cause: new Error("PRIVATE_CHAT_CONTENT") }
    )
  return (
    <Button onClick={() => setFailed(true)}>
      Trigger synthetic render error
    </Button>
  )
}
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
    <UpdateRecovery>
      {window.location.pathname === "/__visuals" ? (
        <VisualsFixture />
      ) : (
        <RouterProvider router={router} />
      )}
    </UpdateRecovery>
  </ThemeProvider>
)
