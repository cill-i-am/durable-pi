import { Link } from "@tanstack/react-router"
import { buttonVariants } from "@/components/ui/button"

export function WorkspaceLinkError() {
  return (
    <main id="main-content" tabIndex={-1} className="loading-view">
      <h1 className="text-lg font-semibold">Couldn’t open this workspace.</h1>
      <p className="text-sm text-muted-foreground">
        Open your workspace to choose an agent and view.
      </p>
      <Link
        to="/"
        search={{}}
        data-slot="button"
        className={buttonVariants({})}
      >
        Open workspace
      </Link>
    </main>
  )
}
