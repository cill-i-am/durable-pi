import { createRef } from "react"
import { renderToString } from "react-dom/server"
import { expect, it } from "vitest"

import { SidebarProvider } from "../src/components/ui/sidebar"
import { AgentEditor } from "../src/features/agents/agents"

it("renders an open assistant editor on the server before its page host exists", () => {
  expect(() =>
    renderToString(
      <SidebarProvider>
        <AgentEditor
          open
          pageContainer={createRef<HTMLDivElement>()}
          onOpenChange={() => {}}
          onSaved={async () => {}}
        />
      </SidebarProvider>
    )
  ).not.toThrow()
})
