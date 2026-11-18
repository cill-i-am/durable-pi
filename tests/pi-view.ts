import type {
  ConversationView,
  EntryRecord,
  LiveState,
} from "@earendil-works/pi-durable"

export const conversationView = (
  entries: readonly EntryRecord[] = [],
  live: LiveState = {}
): ConversationView => ({
  conversation: { id: 0 as ConversationView["conversation"]["id"] },
  entries,
  docs: { "pi.live": live },
})
