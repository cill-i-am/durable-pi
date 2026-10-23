import { LockKeyhole, RefreshCw } from "lucide-react"
import { useEffect, useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useModelCatalog } from "@/features/conversation/use-model-catalog"

import { ChatGPTReconnect } from "./chatgpt-sign-in"
import { useFamily } from "./context"

export function ModelAccess({
  onPendingChange,
}: {
  onPendingChange?: (pending: boolean) => void
}) {
  const { family } = useFamily()
  const { catalog, catalogError, refresh } = useModelCatalog("home", 0)
  const [pending, setPending] = useState(false)
  const [savedConnection, setSavedConnection] = useState(false)
  const [reconnectPending, setReconnectPending] = useState(false)
  useEffect(() => {
    onPendingChange?.(pending || reconnectPending)
    return () => onPendingChange?.(false)
  }, [pending, reconnectPending, onPendingChange])
  const owner = family.role === "owner"
  return (
    <section
      className="settings-section family-settings"
      aria-label="Model access"
    >
      <header className="settings-section-heading">
        <h2>Model access</h2>
        <p>Connect your ChatGPT plan for everyone in your family.</p>
      </header>
      <div className="settings-section-body">
        <div className="settings-provider">
          <div className="family-section-label">
            <h3>ChatGPT</h3>
            <Badge variant="secondary">
              {catalogError
                ? savedConnection
                  ? "Check unavailable"
                  : "Needs attention"
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
            <ChatGPTReconnect
              onPendingChange={setReconnectPending}
              defaultEmail={
                family.members.find((member) => member.role === "owner")
                  ?.email ?? ""
              }
              onConnected={async () => {
                setSavedConnection(true)
                await refresh()
              }}
            />
          )}
          {owner && (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                setPending(true)
                void refresh().finally(() => setPending(false))
              }}
            >
              <RefreshCw />
              {pending ? "Checking…" : "Refresh connection"}
            </Button>
          )}
        </div>
        {catalogError && (
          <Alert role="alert">
            <AlertDescription>
              {owner
                ? savedConnection
                  ? "ChatGPT connection saved. Could not verify model availability. Refresh to retry."
                  : "Your ChatGPT connection needs attention. Sign in above to restore access for the family."
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
