import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { AgentProfile } from "../src/agents/contracts"
import { SidebarProvider } from "../src/components/ui/sidebar"
import { ChatHeader } from "../src/features/conversation/chat-header"

describe("private conversation header", () => {
  it("identifies the actual user and assistant without offering chat invitations", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <ChatHeader
          name="Actual User"
          agent={
            {
              id: "private-assistant",
              name: "Research",
              status: "active",
            } as AgentProfile
          }
        />
      </SidebarProvider>
    )
    expect(html).toContain("People in this chat")
    expect(html).toContain("Research")
    expect(html).toContain("AU")
    expect(html).not.toContain("Invite")
    expect(html).not.toContain("Agent settings and tools")
  })
})
