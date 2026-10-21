import { Effect } from "effect"

import { pinnedRoute } from "../inference/policy"
import type { FileInfo, FileError } from "../workspace/files"
import type { ChatState, TimelineItem } from "./contracts"
import type { ConversationExecution } from "./execution"
import type { ConversationJournal } from "./journal"
import type { Conversations } from "./service"
import type { Turn } from "./turns"

export type SnapshotMetadata = Pick<
  ChatState,
  "runtime" | "access" | "connected" | "memory"
>
export function conversationSnapshot<TError, TRequirements>(
  conversations: typeof Conversations.Service,
  execution: Pick<typeof ConversationExecution.Service, "observe">,
  journal: Pick<typeof ConversationJournal.Service, "activity">,
  metadata: () => Effect.Effect<SnapshotMetadata, TError, TRequirements>,
  replyFiles: (turnId: string) => Effect.Effect<FileInfo[], FileError> = () =>
    Effect.succeed([])
) {
  return Effect.fn("Conversations.snapshot")(function* () {
    const turns = yield* conversations.recent()
    const members = new Map<string, Turn[]>()
    for (const member of yield* conversations.visibleMembers(
      turns.map((turn) => turn.id)
    )) {
      const root = member.parent_id ?? member.id
      const group = members.get(root) ?? []
      group.push(member)
      members.set(root, group)
    }
    const activity = new Map<string, readonly TimelineItem[]>()
    for (const turn of turns) {
      if (turn.session_id && ["running", "stopping"].includes(turn.status)) {
        const observation = yield* execution.observe(
          turn,
          members.get(turn.id) ?? []
        )
        turn.answer = observation.liveAnswer
        activity.set(turn.id, observation.activity)
      }
    }
    const meta = yield* metadata()
    const settings = yield* conversations.settings()
    const visible = yield* Effect.forEach(turns, (turn) =>
      Effect.gen(function* () {
        const saved =
          activity.get(turn.id) ?? (yield* journal.activity(turn.id))
        return {
          id: turn.id,
          origin: turn.origin,
          provenance: turn.provenance,
          text: turn.text,
          status: turn.status,
          preparingFiles: turn.files_pending || undefined,
          answer: turn.answer,
          error: turn.error,
          created_at: turn.created_at,
          attachments: turn.attachments,
          replyFiles: yield* replyFiles(turn.id),
          skills: turn.skills,
          routing: pinnedRoute(turn, settings),
          activity: saved,
          steering: (members.get(turn.id) ?? [])
            .filter((member) => member.parent_id)
            .map(({ id, text, delivery, attachments, provenance }) => ({
              id,
              text,
              delivery,
              attachments,
              provenance,
            })),
        }
      })
    )
    return {
      ...meta,
      turns: visible,
      ...(yield* conversations.selection()),
    } satisfies ChatState
  })
}
