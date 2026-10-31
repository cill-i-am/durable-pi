import {
  Link,
  useRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { useEffect, useState } from "react"

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
      <main id="main-content" tabIndex={-1} className="workspace-recovery">
        <div className="workspace-recovery-content">
          <ReloadRecovery />
        </div>
      </main>
    )
  return (
    <main id="main-content" tabIndex={-1} className="workspace-recovery">
      <div className="workspace-recovery-content">
        <h1 className="text-lg font-semibold">Couldn’t open this workspace.</h1>
        <p className="text-sm text-muted-foreground">
          Try again, or return to your assistants.
        </p>
        {reference && (
          <p className="text-xs text-muted-foreground">
            Error reference: <code>{reference}</code>
          </p>
        )}
        <div className="workspace-recovery-actions">
          <Button disabled={retrying} onClick={retry}>
            {retrying ? "Opening…" : "Try again"}
          </Button>
          <Link
            to="/agents"
            search={{}}
            data-slot="button"
            className={buttonVariants({ variant: "outline" })}
          >
            Open assistants
          </Link>
        </div>
      </div>
    </main>
  )
}
