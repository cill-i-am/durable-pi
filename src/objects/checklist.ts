import { Schema } from "effect"

import {
  Checklist,
  ObjectFailure,
  type ObjectMutation,
  type ChangeSource,
  type FieldChange,
  type ChecklistTask,
} from "./contracts"

export function changeChecklist(
  current: Checklist | undefined,
  input: ObjectMutation,
  source: ChangeSource,
  at: string,
  sequence: number
) {
  if ((current?.revision ?? 0) !== input.expectedRevision)
    throw new ObjectFailure({
      code: "conflict",
      message:
        "This checklist changed while you were editing. Review the latest version before saving again.",
    })
  const changes: FieldChange[] = []
  let value: Checklist
  if (input.action.type === "create") {
    if (current)
      throw new ObjectFailure({
        code: "conflict",
        message: "This checklist already exists.",
      })
    const { title, notes, tasks } = input.action
    if (new Set(tasks.map((task) => task.id)).size !== tasks.length)
      throw new ObjectFailure({
        code: "invalid",
        message: "Task IDs must be unique.",
      })
    value = {
      id: input.id,
      type: "project_checklist",
      schemaVersion: 1,
      revision: 1,
      title,
      notes,
      tasks: tasks.map((task) => ({ ...task, archived: false })),
      archived: false,
      origin: source,
      createdAt: at,
      updatedAt: at,
      lastEvent: sequence,
    }
    changes.push({ taskId: null, field: "created", before: null, after: title })
    if (notes)
      changes.push({ taskId: null, field: "notes", before: null, after: notes })
    for (const task of value.tasks)
      changes.push({
        taskId: task.id,
        field: "added",
        before: null,
        after: JSON.stringify(task),
      })
  } else {
    if (
      input.action.changes.length > 1 &&
      input.action.changes.some((change) => change.type === "archive")
    )
      throw new ObjectFailure({
        code: "invalid",
        message:
          "Archive or restore a checklist separately from other changes.",
      })
    if (!current)
      throw new ObjectFailure({
        code: "not_found",
        message: "This checklist is unavailable in this bot.",
      })
    if (
      current.archived &&
      (input.action.changes.length !== 1 ||
        input.action.changes[0]?.type !== "archive" ||
        input.action.changes[0].archived)
    )
      throw new ObjectFailure({
        code: "read_only",
        message: "Restore this checklist before changing it.",
      })
    value = { ...current, tasks: current.tasks.map((task) => ({ ...task })) }
    value = applyChecklistChanges(value, input.action.changes, changes)
    if (changes.length)
      value = {
        ...value,
        revision: current.revision + 1,
        updatedAt: at,
        lastEvent: sequence,
      }
  }
  if (value.tasks.length > 100 || JSON.stringify(value).length > 180000)
    throw new ObjectFailure({
      code: "limit",
      message:
        "A checklist supports 100 tasks and 180,000 characters, including archived tasks.",
    })
  return { value: Schema.decodeUnknownSync(Checklist)(value), changes }
}

function applyChecklistChanges(
  value: Checklist,
  edits: Exclude<ObjectMutation["action"], { type: "create" }>["changes"],
  changes: FieldChange[]
): Checklist {
  const record = (
    taskId: string | null,
    field: string,
    before: unknown,
    after: unknown
  ) => {
    if (before !== after)
      changes.push({
        taskId,
        field,
        before: before === null ? null : String(before),
        after: after === null ? null : String(after),
      })
  }
  for (const change of edits) {
    switch (change.type) {
      case "edit":
        if (change.title !== undefined) {
          record(null, "title", value.title, change.title)
          value = { ...value, title: change.title }
        }
        if (change.notes !== undefined) {
          record(null, "notes", value.notes, change.notes)
          value = { ...value, notes: change.notes }
        }
        break
      case "archive":
        record(null, "archived", value.archived, change.archived)
        value = { ...value, archived: change.archived }
        break
      case "add_task": {
        if (value.tasks.some((task) => task.id === change.task.id))
          throw new ObjectFailure({
            code: "conflict",
            message:
              "This task ID is already in use, including archived tasks.",
          })
        const task = { ...change.task, archived: false }
        value = { ...value, tasks: [...value.tasks, task] }
        changes.push({
          taskId: task.id,
          field: "added",
          before: null,
          after: JSON.stringify(task),
        })
        break
      }
      case "edit_task": {
        const task = value.tasks.find((item) => item.id === change.taskId)
        if (!task)
          throw new ObjectFailure({
            code: "not_found",
            message: "This task is unavailable in this checklist.",
          })
        if (
          task.archived &&
          (Object.keys(change.patch).length !== 1 ||
            change.patch.archived !== false)
        )
          throw new ObjectFailure({
            code: "read_only",
            message: "Restore this task before editing it.",
          })
        for (const field of Object.keys(
          change.patch
        ) as (keyof typeof change.patch)[])
          record(task.id, field, task[field], change.patch[field])
        const updated: ChecklistTask = { ...task, ...change.patch }
        value = {
          ...value,
          tasks: value.tasks.map((item) =>
            item.id === task.id ? updated : item
          ),
        }
      }
    }
  }
  return value
}
