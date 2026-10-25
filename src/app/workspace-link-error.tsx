import {
  Link,
  useRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router"
import { useEffect, useState } from "react"

import { Button, buttonVariants } from "@/components/ui/button"
import { importFailure } from "@/features/updates/recovery"
import { ReloadRecovery } from "@/features/updates/update-recovery"
import { reportClientError } from "@/observability/browser"

import { useWorkspaceLinkRetry } from "./use-workspace-link-retry"

export function WorkspaceLinkError({ reset, error }: ErrorComponentProps) {
  const router = useRouter()
  const { retrying, retry } = useWorkspaceLinkRetry(error, {
    invalidate: () => router.invalidate(),
    reset,
  })
  const [receipt, setReceipt] = useState<{ error: unknown; id: string }>()
  const reference = receipt?.error === error ? receipt?.id : undefined
  useEffect(() => {
    let disposed = false
    void reportClientError(error).then((id) => {
      if (!disposed && id) setReceipt({ error, id })
    })
    return () => {
      disposed = true
    }
  }, [error])
  if (importFailure(error))
    return (
      <main id="main-content" tabIndex={-1} className="loading-view">
        <ReloadRecovery />
      </main>
    )
  return (
    <main id="main-content" tabIndex={-1} className="loading-view">
      <h1 className="text-lg font-semibold">Couldn’t open this workspace.</h1>
      <p className="text-sm text-muted-foreground">
        Try opening this page again. Your saved conversations are still
        available.
      </p>
      {reference && (
        <p className="text-xs text-muted-foreground">
          Error reference: <code>{reference}</code>
        </p>
      )}
      <Button disabled={retrying} onClick={retry}>
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
