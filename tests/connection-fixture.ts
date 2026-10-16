import type { MCPClientManager } from "agents/mcp/client"
import { ManagedRuntime } from "effect"
import { afterEach } from "vitest"

import { mcpConnectionClient } from "../src/access/adapters/mcp"
import type { ConnectionLedger } from "../src/access/connection-ledger"
import {
  RemoteConnections,
  connectionApplication,
} from "../src/access/connection-service"

const runtimes = new Set<
  ManagedRuntime.ManagedRuntime<RemoteConnections, never>
>()
afterEach(async () => {
  for (const runtime of runtimes) await runtime.dispose()
  runtimes.clear()
})
export function connectionFixture(
  store: ConnectionLedger,
  manager: MCPClientManager
) {
  const runtime = ManagedRuntime.make(
    connectionApplication(store, mcpConnectionClient(manager))
  )
  runtimes.add(runtime)
  return { runtime, service: runtime.runSync(RemoteConnections) }
}
