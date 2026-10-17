import { LockKeyhole, RefreshCw } from "lucide-react"
import { useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useModelCatalog } from "@/features/conversation/use-model-catalog"

import { useFamily } from "./context"

export function ModelAccess() {
  const { family } = useFamily()
  const [error, setError] = useState("")
  const { catalog, refresh } = useModelCatalog("home", 0, setError)
  const [pending, setPending] = useState(false)
  const owner = family.role === "owner"
  return (
    <section
      className="settings-section family-settings"
      aria-label="Model access"
    >
      <header className="settings-section-heading">
        <h2>Model access</h2>
        <p>One connection for the whole family.</p>
      </header>
      <div className="settings-section-body">
        <div className="settings-provider">
          <div className="family-section-label">
            <h3>ChatGPT</h3>
            <Badge variant="secondary">
              {catalog?.error || error
                ? "Needs attention"
                : catalog?.checkedAt
                  ? "Connected"
                  : "Checking…"}
            </Badge>
          </div>
          <p>
            Provided by {owner ? "you" : family.ownerName}. Everyone’s agents
            use this connection.
          </p>
          {owner && (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                setPending(true)
                setError("")
                void refresh().finally(() => setPending(false))
              }}
            >
              <RefreshCw />
              {pending ? "Checking…" : "Refresh connection"}
            </Button>
          )}
        </div>
        {(catalog?.error || error) && (
          <Alert role="alert">
            <AlertDescription>
              {owner
                ? "Your ChatGPT connection needs attention. Reconnect your account, then refresh here to check family access."
                : `${family.ownerName} needs to reconnect ChatGPT. You can keep writing; your draft stays here.`}
            </AlertDescription>
          </Alert>
        )}
        <div>
          <h3>Your models, your choices</h3>
          <p className="settings-description">
            Each person chooses model defaults for their own agents. ChatGPT
            plan limits are shared across the family.
          </p>
        </div>
        <div className="family-privacy">
          <LockKeyhole />
          <div>
            <h3>Shared access. Private work.</h3>
            <p>
              This connection gives your agents model access. Your chats, files,
              memory and connected accounts stay private.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
