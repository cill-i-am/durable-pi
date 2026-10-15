import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { PiHarness } from "agents/harness/pi"
import type {
  EntryRecord,
  SubmissionRecord,
  SnapshotEvent,
  Conversation,
  Cursor,
} from "@earendil-works/pi-durable"
import type { Turn } from "../turns"
import { messageArchiveText } from "../../workspace/files"

export async function readPiReply(
  harness: PiHarness,
  root: Turn,
  members: readonly Turn[]
) {
  const sessionId = root.session_id!
  const storage = await harness.storage()
  const conversation = await harness.conversation(sessionId)
  const stream = await harness.session(sessionId).events()
  const snapshot = stream.snapshot
  await stream.stop()
  const records = new Map<string, SubmissionRecord>()
  for (const member of members) {
    const record = await storage.submissionByRequest(
      conversation.id,
      member.id,
      BACKGROUND_CONTEXT
    )
    if (record) records.set(member.id, record)
  }
  return {
    records,
    snapshot: {
      ...snapshot,
      entries: await originalTranscript(conversation, snapshot),
    },
  }
}

export async function originalTranscript(
  conversation: Pick<Conversation, "entries">,
  snapshot: Pick<SnapshotEvent, "entries">,
  signal?: AbortSignal
): Promise<readonly EntryRecord[]> {
  signal?.throwIfAborted()
  if (!snapshot.entries.some((entry) => entry.head !== undefined))
    return snapshot.entries
  const tail = snapshot.entries.reduce((latest, entry) =>
    entry.id > latest.id ? entry : latest
  ).id
  const entries: EntryRecord[] = []
  let cursor: Cursor | undefined
  do {
    signal?.throwIfAborted()
    const page = await conversation.entries(
      { maxEntryId: tail },
      256,
      cursor,
      BACKGROUND_CONTEXT
    )
    signal?.throwIfAborted()
    entries.push(
      ...page.items.filter((entry) => entry.kind !== "pi.compaction")
    )
    cursor = page.next
  } while (cursor !== undefined)
  return entries.reverse()
}

export function placedInputs(
  members: readonly Turn[],
  records: ReadonlyMap<string, SubmissionRecord>
) {
  const users = new Map<number, Turn>()
  for (const member of members) {
    const record = records.get(member.id)
    if (record?.entry !== undefined) users.set(record.entry, member)
  }
  return users
}

export function replySettled(
  root: Turn,
  members: readonly Turn[],
  reply: {
    records: ReadonlyMap<string, SubmissionRecord>
    snapshot: SnapshotEvent
  }
) {
  if (reply.snapshot.run) return false
  const entries = new Set(reply.snapshot.entries.map((entry) => entry.id))
  return members.every((member) => {
    const record = reply.records.get(member.id)
    if (!record) return root.status === "stopping"
    if (record.status === "queued" || record.status === "placed") return false
    return (
      (record.entry === undefined || entries.has(record.entry)) &&
      (record.status !== "done" ||
        (record.type === "input" && entries.has(record.answer)))
    )
  })
}

const textContent = (content: readonly { type: string; text?: string }[]) =>
  content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")

export function archiveEntries(
  root: Turn,
  entries: readonly EntryRecord[],
  users: ReadonlyMap<number, Turn>
) {
  const output: {
    source: string
    kind: "user" | "talk" | "tool" | "echo" | "note"
    text: string
    date?: string
  }[] = []
  for (const entry of entries)
    for (const [index, message] of (entry.model ?? []).entries()) {
      const source = `${root.id}:${entry.id}:${index}`
      if (message.role === "user") {
        const user = users.get(entry.id)
        if (user)
          output.push({
            source: `${user.origin ? "event" : "user"}:${user.id}`,
            kind: user.origin ? "note" : "user",
            text: messageArchiveText(user.text, user.attachments),
            date: user.created_at,
          })
      } else if (message.role === "assistant") {
        const text = textContent(message.content)
        if (text) output.push({ source: `${source}:talk`, kind: "talk", text })
        for (const block of message.content)
          if (block.type === "toolCall")
            output.push({
              source: `${source}:${block.id}`,
              kind: "tool",
              text: JSON.stringify({
                name: block.name,
                arguments: block.arguments,
              }),
            })
      } else if (message.role === "toolResult")
        output.push({
          source: `${source}:echo`,
          kind: "echo",
          text: textContent(message.content),
        })
    }
  return output
}
