import {
  Link,
  useRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router"
import { useState } from "react"

import { Button, buttonVariants } from "@/components/ui/button"

export function WorkspaceLinkError({ reset }: ErrorComponentProps) {
  const router = useRouter()
  const [retrying, setRetrying] = useState(false)
  async function retry() {
    setRetrying(true)
    try {
      await router.invalidate()
      reset()
    } finally {
      setRetrying(false)
    }
  }
  return (
    <main id="main-content" tabIndex={-1} className="loading-view">
      <h1 className="text-lg font-semibold">Couldn’t open this workspace.</h1>
      <p className="text-sm text-muted-foreground">
        Try opening this page again. Your saved conversations are still
        available.
      </p>
      <Button disabled={retrying} onClick={() => void retry()}>
        {retrying ? "Opening…" : "Try again"}
      </Button>
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
