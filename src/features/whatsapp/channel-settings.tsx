import type { AgentProfile } from "@/agents/contracts"

import { WhatsAppSettings } from "./whatsapp-settings"

export function ChannelSettings({
  agents,
  onPendingChange,
}: {
  agents: readonly AgentProfile[]
  onPendingChange: (pending: boolean) => void
}) {
  return (
    <section className="settings-section" aria-label="Channels">
      <header className="settings-section-heading">
        <h2>Channels</h2>
      </header>
      <div className="settings-section-body">
        <WhatsAppSettings
          agents={agents}
          open
          onPendingChange={onPendingChange}
        />
      </div>
    </section>
  )
}
