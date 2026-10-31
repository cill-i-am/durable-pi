import "@/styles.css"
import React, { useState } from "react"
import { createRoot } from "react-dom/client"

import { ApprovalCard } from "@/features/access/approval-card"
import { DecisionDock } from "@/features/access/decision-dock"

const initial = {
  tools: [
    {
      name: "run_command",
      title: "Run Linux command",
      description: "Run a command",
      mode: "ask",
      revision: 2,
    },
    {
      name: "write_note",
      title: "Write a note",
      description: "Save a note",
      mode: "ask",
      revision: 2,
    },
    {
      name: "browser_open",
      title: "Open browser page",
      description: "Navigate browser",
      mode: "ask",
      revision: 2,
    },
  ],
  approvals: [
    {
      id: "one",
      turnId: "turn",
      tool: "run_command",
      input: JSON.stringify({
        command: "printf 'Complete action scope'",
        timeout: 30000,
        workingDirectory: "/workspace",
      }),
      createdAt: 1,
      expiresAt: 9000000000000,
      status: "pending",
      revision: 4,
    },
    {
      id: "two",
      turnId: "turn",
      tool: "write_note",
      input: '{"path":"family/week.txt","body":"A private planning note"}',
      createdAt: 2,
      expiresAt: 9000000000000,
      status: "pending",
      revision: 1,
    },
    {
      id: "three",
      turnId: "turn",
      tool: "browser_open",
      input: '{"url":"https://example.invalid"}',
      createdAt: 3,
      expiresAt: 9000000000000,
      status: "pending",
      revision: 1,
    },
  ],
}
let server = structuredClone(initial)
const fixture = {
  calls: [],
  refreshes: 0,
  aborted: 0,
  mode: "success",
  refreshStatus: null,
}
window.fixture = fixture
const realFetch = window.fetch.bind(window)
window.fetch = (url, options) => {
  if (!String(url).includes("/api/agent/access/decide"))
    return realFetch(url, options)
  const command = JSON.parse(options.body)
  fixture.calls.push(command)
  if (fixture.mode === "uncertain")
    return Promise.reject(new TypeError("Fixture connection unavailable"))
  if (fixture.mode === "held")
    return new Promise((resolve, reject) => {
      fixture.release = () => resolve(Response.json(server))
      options.signal.addEventListener(
        "abort",
        () => {
          fixture.aborted++
          reject(new DOMException("Aborted", "AbortError"))
        },
        { once: true }
      )
    })
  server = {
    ...server,
    approvals: server.approvals.map((item) =>
      item.id === command.id
        ? {
            ...item,
            status: command.approve ? "approved" : "denied",
            revision: item.revision + 1,
          }
        : item
    ),
    tools: server.tools.map((tool) =>
      command.remember &&
      tool.name === server.approvals.find((item) => item.id === command.id).tool
        ? { ...tool, mode: "allow", revision: tool.revision + 1 }
        : tool
    ),
  }
  return Promise.resolve(Response.json(server))
}
function App() {
  const [access, setAccess] = useState(server)
  const [show, setShow] = useState(true)
  const [disabled, setDisabled] = useState(false)
  fixture.setDisabled = setDisabled
  fixture.unmount = () => setShow(false)
  fixture.replace = (changes) => {
    server = {
      ...server,
      approvals: server.approvals.map((item) =>
        item.id === "one" ? { ...item, ...changes } : item
      ),
    }
    setAccess(server)
  }
  const refresh = React.useCallback(() => {
    fixture.refreshes++
    if (fixture.refreshStatus)
      server = {
        ...server,
        approvals: server.approvals.map((item) =>
          item.id === "one"
            ? {
                ...item,
                status: fixture.refreshStatus,
                revision: item.revision + 1,
              }
            : item
        ),
      }
    setAccess(structuredClone(server))
  }, [])
  return (
    <main
      style={{
        maxWidth: 752,
        padding: 16,
        margin: "48px auto",
        fontFamily: "var(--font-sans)",
      }}
    >
      <h1 style={{ fontSize: "var(--text-md)", marginBottom: 24 }}>
        Decisions
      </h1>
      {access.approvals
        .filter((item) => item.status !== "pending")
        .map((approval) => (
          <ApprovalCard
            key={approval.id}
            agentId="home"
            disabled={disabled}
            approval={approval}
            toolLabel={
              access.tools.find((tool) => tool.name === approval.tool)?.title
            }
          />
        ))}
      {show ? (
        <DecisionDock
          agentId="home"
          agentName="Atlas"
          access={access}
          disabled={disabled}
          onRefresh={refresh}
        />
      ) : (
        <p>Closed</p>
      )}
      <textarea
        aria-label="Message Atlas"
        placeholder="Message Atlas…"
        style={{
          marginTop: 12,
          padding: 12,
          width: "100%",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md)",
        }}
      />
    </main>
  )
}
createRoot(document.getElementById("root")).render(<App />)
