import type {
  ChatState,
  ConversationFrame,
} from "../../conversations/contracts"

export function applyConversationFrame(
  state: ChatState | null,
  frame: ConversationFrame
): ChatState | null {
  if (frame.type === "snapshot") return frame.state
  if (!state) return null
  const turns = new Map(state.turns.map((turn) => [turn.id, turn]))
  for (const turn of frame.turns) turns.set(turn.id, turn)
  return {
    ...state,
    ...frame.meta,
    turns: frame.ids.flatMap((id) => turns.get(id) ?? []),
  }
}
