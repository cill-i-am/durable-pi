import { Effect } from "effect"

import { agentGateway } from "../../src/agent/adapters/gateway"
import agentWorker from "../../src/agent/worker"
import { agentProxy } from "../../src/auth/adapters/agent-proxy"
import { executionWorkerRequest } from "../../src/execution/worker"
import { runObserved } from "../../src/observability/worker"
import { BackgroundGroupProbe } from "./background-worker"
import { BrowserRecoveryBot } from "./browser-worker"
import {
  MailboxBot,
  mailboxFixtureRequest,
} from "./communication-control-worker"
import { eventStreamProbe } from "./event-stream-worker"
import { LoopBot } from "./loop-worker"
import { MaintenanceProbe } from "./maintenance-worker"
import { PersonalAgentProbe } from "./personal-agent-worker"
import { SqlitePilot } from "./sqlite-worker"
import { TerminalProbe } from "./terminal-worker"
import { WhatsAppSink } from "./whatsapp-sink-worker"

export {
  MailboxBot,
  MaintenanceProbe,
  WhatsAppSink,
  LoopBot,
  BrowserRecoveryBot,
  PersonalAgentProbe,
  BackgroundGroupProbe,
  TerminalProbe,
  SqlitePilot,
}

interface Env {
  MAINTENANCE: DurableObjectNamespace<MaintenanceProbe>
  WHATSAPP: DurableObjectNamespace<WhatsAppSink>
  SQL_PILOT: DurableObjectNamespace<SqlitePilot>
  LOADER: WorkerLoader
  PERSONAL: DurableObjectNamespace<PersonalAgentProbe>
  BACKGROUND: DurableObjectNamespace<BackgroundGroupProbe>
  TERMINALS: DurableObjectNamespace<TerminalProbe>
  BROWSERS: DurableObjectNamespace<BrowserRecoveryBot>
  LOOPS: DurableObjectNamespace<LoopBot>
  BOTS: DurableObjectNamespace<MailboxBot>
}
const personalProbeOwners = new Map([
  ["personal-apps-disposal", "personal-apps-disposal-owner"],
  ["personal-communication-disposal", "personal-communication-disposal-owner"],
  ["personal-routines-disposal", "personal-routines-disposal-owner"],
  ["personal-runner-causes", "personal-runner-causes-owner"],
  ["personal-conversation-disposal", "personal-conversation-disposal-owner"],
  ["personal-coordination-disposal", "personal-coordination-disposal-owner"],
  ["personal-coordination", "personal-coordination-owner"],
  ["whatsapp", "whatsapp-owner"],
  ["whatsapp-images", "whatsapp-images-owner"],
  ["whatsapp-audio", "whatsapp-audio-owner"],
  ["email", "email-owner"],
  ["email-held", "email-held-owner"],
  ["personal-credential", "personal-credential-owner"],
  ["personal-chatgpt", "personal-chatgpt-owner"],
  ["personal-code", "personal-code-owner"],
  ["personal-terminal", "personal-terminal-owner"],
  ["personal", "personal-owner"],
  ["personal-tasks", "task-controls-owner"],
  ["personal-maintenance", "personal-maintenance-owner"],
])
let websiteSessionValid = true
let websiteSessionReads = 0
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url)
    if (url.pathname === "/deployment")
      return agentWorker.fetch(
        new Request("https://agent.internal/__deployment", {
          headers: { "x-owner-id": "gateway-owner" },
        }),
        { AGENT: env.PERSONAL },
        ctx
      )
    if (url.pathname.startsWith("/encoding/"))
      return eventStreamProbe(request, ctx)
    if (url.pathname.startsWith("/sql-pilot/"))
      return env.SQL_PILOT.getByName(url.pathname.split("/")[2]!).fetch(request)
    if (url.pathname === "/website-session") {
      if (request.method === "POST") websiteSessionValid = false
      return Response.json({
        valid: websiteSessionValid,
        reads: websiteSessionReads,
      })
    }
    if (url.pathname === "/website-probe")
      return env.PERSONAL.getByName("gateway-owner").fetch(
        new Request("https://probe/inspect")
      )
    if (url.pathname.startsWith("/website/")) {
      const headers = new Headers(request.headers)
      headers.set("origin", "https://website.example")
      return agentProxy(
        new Request(
          new Request(
            `https://website.example/api/agent/${url.pathname.slice(9)}${url.search}`,
            request
          ),
          { headers }
        ),
        {
          appUrl: "https://website.example",
          owner: Effect.sync(() => {
            websiteSessionReads++
            return websiteSessionValid ? { id: "gateway-owner" } : null
          }),
          forward: (forwarded) =>
            agentGateway(forwarded, { AGENT: env.PERSONAL }, ctx),
          own: (pending) => ctx.waitUntil(pending),
        }
      )
    }
    if (url.pathname.startsWith("/gateway/")) {
      const headers = new Headers(request.headers)
      headers.set("x-owner-id", "gateway-owner")
      return agentGateway(
        new Request(
          `https://agent.internal/api/agent/${url.pathname.slice(9)}${url.search}`,
          {
            method: request.method,
            headers,
            signal: request.signal,
            body: request.method === "GET" ? undefined : request.body,
          }
        ),
        { AGENT: env.PERSONAL },
        ctx
      )
    }
    if (url.pathname.startsWith("/native-terminal/"))
      return env.TERMINALS.getByName("native-terminal-direct").fetch(
        new Request(
          `https://terminal.internal/${url.pathname.slice(17)}`,
          request
        )
      )
    if (url.pathname === "/native-execution")
      return executionWorkerRequest(
        new Request("https://execution.internal/run", request),
        env.LOADER
      )
    if (url.pathname.startsWith("/browser/"))
      return env.BROWSERS.getByName(url.pathname).fetch(request)
    if (url.pathname.startsWith("/maintenance/"))
      return env.MAINTENANCE.getByName("maintenance-test").fetch(request)
    if (url.pathname.startsWith("/loops/"))
      return env.LOOPS.getByName("loop-test").fetch(request)
    const personalOwner = personalProbeOwners.get(
      url.pathname.split("/")[1] ?? ""
    )
    if (personalOwner)
      return env.PERSONAL.getByName(personalOwner).fetch(request)
    if (url.pathname === "/health") return new Response("local fixture")
    if (url.pathname === "/telemetry")
      return runObserved(
        Effect.gen(function* () {
          const parent = yield* Effect.currentSpan
          const child = yield* Effect.gen(function* () {
            yield* Effect.sleep("1 millis")
            const span = yield* Effect.currentSpan
            return {
              name: span.name,
              id: span.spanId,
              parent:
                span.parent._tag === "Some" ? span.parent.value.spanId : null,
            }
          }).pipe(Effect.withSpan("fixture.child"))
          return Response.json({ id: parent.spanId, name: parent.name, child })
        }).pipe(Effect.withSpan("fixture.request"))
      )
    if (request.method !== "POST")
      return new Response("Not found", { status: 404 })
    return mailboxFixtureRequest(request, env)
  },
}

export { LegacyAgentProbe } from "./legacy-agent-worker"
