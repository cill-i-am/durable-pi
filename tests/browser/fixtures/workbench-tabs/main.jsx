import "@/styles.css"
import "@/app/workspace.css"
import React, { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"

import { WorkbenchPanel } from "@/app/workbench.tsx"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"

const fixture = { routes: [], mounts: {}, unmounts: {}, closed: 0, nodes: {} }
window.fixture = fixture
function Tool({ panel }) {
  const [draft, setDraft] = useState("")
  const node = useRef(null)
  useEffect(() => {
    fixture.mounts[panel] = (fixture.mounts[panel] ?? 0) + 1
    fixture.nodes[panel] = node.current
    return () => {
      fixture.unmounts[panel] = (fixture.unmounts[panel] ?? 0) + 1
    }
  }, [panel])
  return (
    <div ref={node} style={{ padding: 24 }}>
      <h2>{panel} tool fixture</h2>
      <label>
        Draft {panel}
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
    </div>
  )
}
function App() {
  const [route, setRoute] = useState("files")
  const [open, setOpen] = useState(true)
  const [locked, setLocked] = useState(false)
  const [overlay, setOverlay] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [mounted, setMounted] = useState(true)
  const trigger = useRef(null)
  fixture.route = (panel) => {
    setRoute(panel)
    setOpen(true)
  }
  fixture.lock = setLocked
  fixture.overlay = setOverlay
  fixture.unmount = () => setMounted(false)
  return (
    <main>
      <button ref={trigger} onClick={() => setOpen(true)}>
        Show workbench
      </button>
      <div
        className="agent-columns"
        data-workbench-expanded={expanded}
        style={{ height: "calc(100dvh - 44px)" }}
      >
        <div style={{ flex: 1, padding: 24 }} hidden={expanded}>
          <h1>Conversation fixture</h1>
        </div>
        {mounted && (
          <WorkbenchPanel
            open={open}
            value={route}
            onChange={(panel) => {
              fixture.routes.push(panel)
              if (panel) setRoute(panel)
              setOpen(panel !== null)
            }}
            onClosed={() => fixture.closed++}
            returnFocus={trigger}
            agentName="Navi"
            agentReference="home"
            locked={locked}
            overlayOpen={overlay}
            mobileNavigation={null}
            renderTool={(panel) => <Tool panel={panel} />}
            onExpandedChange={setExpanded}
            overlays={
              <Sheet open={overlay} onOpenChange={setOverlay}>
                <SheetContent>
                  <SheetTitle>Settings fixture</SheetTitle>
                  <button onClick={() => setOverlay(false)}>
                    Close settings fixture
                  </button>
                </SheetContent>
              </Sheet>
            }
          />
        )}
      </div>
    </main>
  )
}
createRoot(document.getElementById("root")).render(<App />)
