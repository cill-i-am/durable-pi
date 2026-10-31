import {
  HeadContent,
  Link,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router"
import { buttonVariants } from "@workspace/ui/components/button"
import { ThemeProvider } from "next-themes"

import { WorkspaceLinkError } from "@/app/workspace-link-error"
import { WorkspaceMotion } from "@/app/workspace-motion"
import { UpdateRecovery } from "@/features/updates/update-recovery"

import appCss from "../styles.css?url"
import "../app/workspace.css"

export const Route = createRootRoute({
  errorComponent: WorkspaceLinkError,
  head: () => ({
    meta: [
      { name: "robots", content: "noindex, nofollow" },
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content:
          "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content",
      },
      {
        title: "Pi — Your continuous chat",
      },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "manifest", href: "/manifest.json" },
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  notFoundComponent: () => (
    <main id="main-content" tabIndex={-1} className="workspace-recovery">
      <div className="workspace-recovery-content">
        <h1 className="text-lg font-semibold">Page not found</h1>
        <p className="text-sm text-muted-foreground">
          This page is unavailable.
        </p>
        <Link
          to="/agents"
          search={{}}
          className={buttonVariants({ variant: "outline" })}
        >
          Open assistants
        </Link>
      </div>
    </main>
  ),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          storageKey="durable-pi:theme"
          disableTransitionOnChange
        >
          <WorkspaceMotion>
            <UpdateRecovery>{children}</UpdateRecovery>
          </WorkspaceMotion>
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  )
}
