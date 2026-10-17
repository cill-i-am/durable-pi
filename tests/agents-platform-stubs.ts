import { vi } from "vitest"

// Node unit tests exercise Pi's application boundaries. Native Agent classes,
// named RPC and Chat SDK SQLite facets are verified by the workerd suites.
const nativeOnly = () => {
  throw new Error("This operation requires the native workerd fixture")
}
vi.mock("agents", () => ({
  Agent: class {},
  getAgentByName: () => nativeOnly(),
}))
vi.mock("agents/chat-sdk", () => ({
  ChatSdkStateAgent: class {},
  createChatSdkState: () => nativeOnly(),
}))
