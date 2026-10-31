import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
  useRouterState,
} from "@tanstack/react-router"
import { Button } from "@workspace/ui/components/button"
import { ThemeProvider } from "next-themes"
import { useState } from "react"
import { createRoot } from "react-dom/client"

import { ChatApp } from "../../src/app/workspace"
import { WorkspaceLinkError } from "../../src/app/workspace-link-error"
import { WorkspaceMotion } from "../../src/app/workspace-motion"
import {
  ForgotPassword,
  ResetPassword,
  TwoFactorChallenge,
} from "../../src/features/auth"
import { JoinFamily } from "../../src/features/family/join"
import { UpdateRecovery } from "../../src/features/updates/update-recovery"
import { workspaceNavigationContext } from "../../src/navigation/settings-stack"
import {
  workspaceView,
  validateGlobalSettingsSearch,
  validateConnectionSettingsSearch,
  validateAuthSearch,
} from "../../src/navigation/workspace"
import { reportClientError } from "../../src/observability/browser"
import { Route as PanelRoute } from "../../src/routes/_workspace.agents.$agentId.$panel.index"
import { Route as AgentEditRoute } from "../../src/routes/_workspace.agents.$agentId.edit"
import { Route as SettingsRoute } from "../../src/routes/_workspace.agents.$agentId.settings.$section"
import { Route as AgentSettingsIndexRoute } from "../../src/routes/_workspace.agents.$agentId.settings.index"
import { Route as FamilyRoute } from "../../src/routes/_workspace.family"
import { Route as ModelAccessRoute } from "../../src/routes/_workspace.family.model-access"
import { Route as SettingsIndexRoute } from "../../src/routes/_workspace.settings.index"
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
  beforeLoad: workspaceNavigationContext,
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
        getParentRoute: () => workspace,
        path: "/agents/new",
        validateSearch: validateAuthSearch,
        component: () => null,
      }),
      createRoute({
        getParentRoute: () => workspace,
        path: "/agents/$agentId/edit",
        params: AgentEditRoute.options.params,
        validateSearch: AgentEditRoute.options.validateSearch,
        component: AgentEditRoute.options.component,
      }),
      createRoute({
        getParentRoute: () => workspace,
        path: "/settings",
        validateSearch: SettingsIndexRoute.options.validateSearch,
        component: SettingsIndexRoute.options.component,
      }),
      createRoute({
        getParentRoute: () => workspace,
        path: "/agents/$agentId/settings",
        params: AgentSettingsIndexRoute.options.params,
        validateSearch: AgentSettingsIndexRoute.options.validateSearch,
        beforeLoad: ({ params, search }) =>
          workspaceView({ ...params, section: "agent-settings" }, search),
        component: AgentSettingsIndexRoute.options.component,
      }),
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
      ...(
        ["account", "preferences", "connections", "skills", "channels"] as const
      ).map((section) =>
        createRoute({
          getParentRoute: () => workspace,
          path: `/settings/${section}`,
          validateSearch:
            section === "connections"
              ? validateConnectionSettingsSearch
              : validateGlobalSettingsSearch,
          component: () => null,
        })
      ),
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
      path: "/forgot-password",
      validateSearch: validateAuthSearch,
      component: ForgotPassword,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/reset-password",
      validateSearch: validateAuthSearch,
      component: ResetPassword,
    }),
    createRoute({
      getParentRoute: () => root,
      path: "/two-factor",
      validateSearch: validateAuthSearch,
      component: TwoFactorChallenge,
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
createRoot(document.getElementById("root")!).render(
  <ThemeProvider attribute="class">
    <WorkspaceMotion>
      <UpdateRecovery>
        <RouterProvider router={router} />
      </UpdateRecovery>
    </WorkspaceMotion>
  </ThemeProvider>
)
