import { Effect } from "effect"

import type { PersonalAgent } from "../../agent/worker"
import { Communication } from "../../communication/communication"
import { terminal } from "../../communication/contracts"
import { preserveFatal } from "../../shared/effect"
import {
  type TaskReference,
  taskError,
  type Task,
  TaskControlError,
} from "../contracts"

/** Projection over original records; cancellation remains owned by each domain. */
export function localTaskControls(owner: PersonalAgent) {
  const requestView = (
    turn: { id: string; text: string; status: string; files_pending?: boolean },
    needsApproval = false
  ): Task => ({
    id: turn.id,
    kind: "request",
    title: turn.text.slice(0, 300),
    state: !["queued", "preparing", "running"].includes(turn.status)
      ? turn.status
      : needsApproval
        ? "needs-approval"
        : turn.files_pending
          ? "preparing-files"
          : turn.status,
    terminal: !["queued", "preparing", "running", "stopping"].includes(
      turn.status
    ),
  })
  const request = (
    turn: Parameters<typeof requestView>[0],
    needsApproval = false
  ) =>
    Effect.gen(function* () {
      const view = requestView(turn, needsApproval)
      if (!view.terminal) return view
      const id = yield* owner.delegationLedger.parent(turn.id)
      if (!id) return view
      const group = yield* owner.delegationLedger.group(id)
      if (!group.detached) return view
      if (yield* owner.coordination.store.closed(turn.id))
        return { ...view, state: "cancelled" }
      if (
        group.closed ||
        group.deadline <= Date.now() ||
        !(yield* owner.coordination.rootLive(turn.id))
      )
        return view
      return { ...view, state: "running", terminal: false }
    })
  const mailbox = owner.communication.runtime.runSync(Communication)
  const bot = (task: Parameters<typeof terminal>[0]): Task => ({
    id: task.id,
    kind: "bot-task",
    title:
      "objective" in task.request.payload
        ? task.request.payload.objective
        : "Bot task",
    state: task.status,
    terminal: terminal(task),
  })
  const background = (
    row: NonNullable<
      Effect.Success<ReturnType<typeof owner.backgroundMailbox.get>>
    >
  ): Task => ({
    id: String(row.id),
    kind: "background",
    title: row.handoff.input.objective,
    state: row.status === "cancelled" ? "cancellation-requested" : row.status,
    terminal: ["delivered", "cancelled"].includes(row.status),
  })
  const get = (ref: TaskReference) =>
    Effect.gen(function* () {
      if (ref.kind === "request") {
        const turn = yield* owner.conversations.get(ref.id)
        if (turn) return yield* request(turn)
      } else if (ref.kind === "bot-task") return bot(yield* mailbox.get(ref.id))
      else {
        if (
          !/^[1-9][0-9]*$/.test(ref.id) ||
          !Number.isSafeInteger(Number(ref.id))
        )
          return yield* taskError("invalid", "Invalid background task handle.")
        const row = yield* owner.backgroundMailbox.get(Number(ref.id))
        if (row) return background(row)
      }
      return yield* taskError(
        "not_found",
        "This task does not exist in that agent."
      )
    })
  return {
    list: () =>
      Effect.gen(function* () {
        const approvals = (yield* owner.access.state()).approvals.filter(
          (a) => a.status === "pending"
        )
        const turns = yield* owner.conversations.unfinished()
        const known = new Set(turns.map((turn) => turn.id))
        for (const id of yield* owner.delegationLedger.catalog()) {
          const group = yield* owner.delegationLedger.group(id)
          if (!group.detached || group.closed || known.has(group.turnId))
            continue
          const turn = yield* owner.conversations.get(group.turnId)
          if (turn) {
            turns.push(turn)
            known.add(turn.id)
          }
        }
        const requests = (yield* Effect.forEach(turns, (turn) =>
          request(
            turn,
            approvals.some((a) => a.turnId === turn.id)
          )
        )).filter((task) => !task.terminal)
        const tasks = (yield* owner.communication.mailbox.pending())
          .filter((t) => !terminal(t))
          .map(bot)
        const groups: Task[] = []
        for (let offset = 0; ;) {
          const rows = yield* owner.backgroundMailbox.list(offset)
          if (!rows.length) break
          groups.push(
            ...rows
              .filter((row) => !["delivered", "cancelled"].includes(row.status))
              .map(background)
          )
          offset += rows.length
        }
        return [...requests, ...tasks, ...groups]
      }).pipe(preserveFatal, Effect.mapError(toTaskError)),
    stop: (ref: TaskReference) =>
      Effect.gen(function* () {
        const before = yield* get(ref)
        if (before.terminal) return before
        if (ref.kind === "request") yield* owner.stopConversation(ref.id)
        else if (ref.kind === "bot-task") yield* mailbox.cancel(ref.id)
        else yield* owner.background.stop(Number(ref.id))
        return yield* get(ref)
      }).pipe(preserveFatal, Effect.mapError(toTaskError)),
  }
}

function toTaskError(error: { _tag: string; code?: string }) {
  if (error instanceof TaskControlError) return error
  return taskError(
    error.code === "not_found" ? "not_found" : "unavailable",
    error.code === "not_found"
      ? "This task does not exist in that agent."
      : "This task's state could not be confirmed. Retry the same handle."
  )
}
