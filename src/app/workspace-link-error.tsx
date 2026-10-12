import { Link } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"

export function WorkspaceLinkError() {
  return (
    <main className="loading-view">
      <h1 className="text-lg font-semibold">This workspace link is invalid.</h1>
      <p className="text-sm text-muted-foreground">
        Open your workspace to choose an agent and view.
      </p>
      <Button nativeButton={false} render={<Link to="/" search={{}} />}>
        Open workspace
      </Button>
    </main>
  )
}
