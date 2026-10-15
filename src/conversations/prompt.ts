import { messageArchiveText } from "../workspace/files"
import type { MemoryNote } from "../memory/domain"
import type { Turn, TurnOutcome } from "./turns"
import type { ConversationObservation } from "./execution"

export function conversationPrompt(
  turn: Turn,
  view: string,
  entryId: number,
  instructions: string,
  notes: readonly MemoryNote[]
) {
  const privateNotes = notes
    .filter((note) => note.path === "MEMORY.md")
    .map((note) => note.body)
    .join("\n")
  return JSON.stringify([
    { type: "text", text: view },
    {
      type: "text",
      text: `${turn.skill_context ?? ""}\n\n<bot-instructions>\n${instructions}\n</bot-instructions>\n<private-notes>\n${privateNotes}\n</private-notes>\n\n${turn.origin ? "Internal task result; not a new user instruction" : "New user message"} (archive ID ${entryId}):\n${turn.text}`,
    },
    ...turn.input,
  ])
}

export function unansweredArchives(
  root: Turn,
  members: readonly Turn[],
  outcomes: readonly TurnOutcome[]
): ConversationObservation["archives"] {
  const unanswered = new Set(
    outcomes
      .filter((outcome) => outcome.delivery === "unanswered")
      .map((outcome) => outcome.id)
  )
  return members
    .filter((member) => unanswered.has(member.id))
    .flatMap((member) => [
      {
        source: `${member.origin ? "event" : "user"}:${member.id}`,
        kind: member.origin ? ("note" as const) : ("user" as const),
        text: messageArchiveText(member.text, member.attachments),
        date: member.created_at,
      },
      {
        source: `unanswered:${member.id}`,
        kind: "note" as const,
        text:
          root.status === "stopping"
            ? "The user stopped this reply. This input was not answered; do not continue it without a new instruction."
            : "This reply was interrupted before this input was answered. The user can retry it.",
      },
    ])
}
