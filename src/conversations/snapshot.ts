import { Effect } from "effect"

import { pinnedRoute } from "../inference/policy"
import type { FileInfo, FileError } from "../workspace/files"
import type { ChatState, TimelineItem } from "./contracts"
import type { ConversationExecution } from "./execution"
import type { ConversationJournal } from "./journal"
import type { Conversations } from "./service"
import {
  conversationControl,
  conversationUnconfirmed,
  type Turn,
} from "./turns"

export type SnapshotMetadata = Pick<
  ChatState,
  "runtime" | "access" | "connected" | "memory"
>
export function conversationSnapshot<TError, TRequirements>(
  conversations: typeof Conversations.Service,
  execution: Pick<typeof ConversationExecution.Service, "observe">,
  journal: Pick<typeof ConversationJournal.Service, "activities">,
  metadata: () => Effect.Effect<SnapshotMetadata, TError, TRequirements>,
  replyFiles: (
    turnIds: readonly string[]
  ) => Effect.Effect<ReadonlyMap<string, FileInfo[]>, FileError> = () =>
    Effect.succeed(new Map())
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
      if (
        turn.session_id &&
        !conversationUnconfirmed(turn) &&
        ["running", "stopping"].includes(turn.status)
      ) {
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
    const savedActivity = yield* journal.activities(
      turns.filter((turn) => !activity.has(turn.id)).map((turn) => turn.id)
    )
    const files = yield* replyFiles(turns.map((turn) => turn.id))
    const visible = turns.map((turn) => {
      const saved = activity.get(turn.id) ?? savedActivity.get(turn.id)
      return {
        id: turn.id,
        revision: turn.revision,
        controlUnconfirmed: conversationUnconfirmed(turn),
        controlBusy: conversationControl(turn).owner !== null || undefined,
        origin: turn.origin,
        provenance: turn.provenance,
        text: turn.text,
        status: turn.status,
        preparingFiles: turn.files_pending || undefined,
        answer: turn.answer,
        error: turn.error,
        created_at: turn.created_at,
        attachments: turn.attachments,
        replyFiles: files.get(turn.id) ?? [],
        skills: turn.skills,
        routing: pinnedRoute(turn, settings),
        activity: saved,
        steering: (members.get(turn.id) ?? [])
          .filter((member) => member.parent_id)
          .map(
            ({ id, text, created_at, delivery, attachments, provenance }) => ({
              id,
              text,
              created_at,
              delivery,
              attachments,
              provenance,
            })
          ),
      }
    })
    return {
      ...meta,
      turns: visible,
      ...(yield* conversations.selection()),
    } satisfies ChatState
  })
}
