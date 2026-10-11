import { Schema } from "effect"

export const ObjectId = Schema.String.check(
  Schema.isPattern(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
  )
)
export const OperationId = Schema.String.check(
  Schema.isPattern(/^(?:[a-f0-9-]{36}|tool:[0-9]+)$/i)
)
export const Revision = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
)
const text = (max: number) => Schema.String.check(Schema.isMaxLength(max))
export const Title = text(120).check(
  Schema.isMinLength(1),
  Schema.isPattern(/\S/)
)
export const DueDate = Schema.NullOr(
  Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
    Schema.makeFilter((date) => {
      const time = Date.parse(date + "T00:00:00.000Z")
      return (
        Number.isFinite(time) &&
        new Date(time).toISOString().slice(0, 10) === date
      )
    })
  )
)
export const TaskStatus = Schema.Literals([
  "pending",
  "active",
  "blocked",
  "completed",
])
export const TaskInput = Schema.Struct({
  id: ObjectId,
  title: Title,
  status: TaskStatus,
  dueDate: DueDate,
  notes: text(2000),
})
export const ChecklistTask = Schema.Struct({
  ...TaskInput.fields,
  archived: Schema.Boolean,
})
export type ChecklistTask = typeof ChecklistTask.Type
export const ChangeSource = Schema.Struct({
  actor: Schema.Literals(["user", "agent"]),
  surface: Schema.Literals(["chat", "workbench", "tool"]),
  turnId: Schema.NullOr(ObjectId),
  toolCallId: Schema.NullOr(text(200)),
})
export type ChangeSource = typeof ChangeSource.Type
export const Checklist = Schema.Struct({
  id: ObjectId,
  type: Schema.Literal("project_checklist"),
  schemaVersion: Schema.Literal(1),
  revision: Revision,
  title: Title,
  notes: text(4000),
  tasks: Schema.Array(ChecklistTask).check(Schema.isMaxLength(100)),
  archived: Schema.Boolean,
  origin: ChangeSource,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastEvent: Revision,
})
export type Checklist = typeof Checklist.Type
export const TaskPatch = Schema.Struct({
  title: Schema.optionalKey(Title),
  status: Schema.optionalKey(TaskStatus),
  dueDate: Schema.optionalKey(DueDate),
  notes: Schema.optionalKey(text(2000)),
  archived: Schema.optionalKey(Schema.Boolean),
}).check(Schema.makeFilter((patch) => Object.keys(patch).length > 0))
export const ChecklistChange = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("edit"),
    title: Schema.optionalKey(Title),
    notes: Schema.optionalKey(text(4000)),
  }).check(
    Schema.makeFilter(
      (change) => change.title !== undefined || change.notes !== undefined
    )
  ),
  Schema.Struct({ type: Schema.Literal("add_task"), task: TaskInput }),
  Schema.Struct({
    type: Schema.Literal("edit_task"),
    taskId: ObjectId,
    patch: TaskPatch,
  }),
  Schema.Struct({ type: Schema.Literal("archive"), archived: Schema.Boolean }),
])
export type ChecklistChange = typeof ChecklistChange.Type
export const CreateChecklist = Schema.Struct({
  type: Schema.Literal("create"),
  title: Title,
  notes: text(4000),
  tasks: Schema.Array(TaskInput).check(Schema.isMaxLength(100)),
})
export const ObjectMutation = Schema.Struct({
  surface: Schema.optionalKey(Schema.Literals(["chat", "workbench"])),
  id: ObjectId,
  operationId: OperationId,
  expectedRevision: Revision,
  action: Schema.Union([
    CreateChecklist,
    Schema.Struct({
      type: Schema.Literal("update"),
      changes: Schema.Array(ChecklistChange).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(20)
      ),
    }),
  ]),
})
export type ObjectMutation = typeof ObjectMutation.Type
export const FieldChange = Schema.Struct({
  taskId: Schema.NullOr(ObjectId),
  field: Schema.String,
  before: Schema.NullOr(Schema.String),
  after: Schema.NullOr(Schema.String),
})
export type FieldChange = typeof FieldChange.Type
export const ObjectEvent = Schema.Struct({
  id: Schema.String,
  objectId: ObjectId,
  revision: Revision,
  sequence: Revision,
  source: ChangeSource,
  at: Schema.String,
  changes: Schema.Array(FieldChange),
})
export type ObjectEvent = typeof ObjectEvent.Type
export const MutationReceipt = Schema.Struct({
  objectId: ObjectId,
  revision: Revision,
  eventId: Schema.String,
})
export type MutationReceipt = typeof MutationReceipt.Type
export const ObjectDetail = Schema.Struct({
  object: Checklist,
  events: Schema.Array(ObjectEvent),
  nextHistory: Schema.NullOr(Revision),
})
export type ObjectDetail = typeof ObjectDetail.Type
export const ObjectSummary = Schema.Struct({
  id: ObjectId,
  type: Schema.Literal("project_checklist"),
  title: Title,
  revision: Revision,
  completed: Revision,
  total: Revision,
  archived: Schema.Boolean,
  lastEvent: Revision,
})
export type ObjectSummary = typeof ObjectSummary.Type
export const ObjectList = Schema.Struct({
  objects: Schema.Array(ObjectSummary),
})
export const ObjectContext = Schema.Struct({
  sequence: Revision,
  offeredThrough: Revision,
  objects: Schema.Array(ObjectSummary),
})
export type ObjectContext = typeof ObjectContext.Type
export class ObjectFailure extends Schema.TaggedError<ObjectFailure>()(
  "ObjectFailure",
  {
    code: Schema.Literals([
      "invalid",
      "conflict",
      "not_found",
      "read_only",
      "unavailable",
      "limit",
      "cancelled",
    ]),
    message: Schema.String,
  }
) {}
export const objectSummary = (value: Checklist): ObjectSummary => ({
  id: value.id,
  type: value.type,
  title: value.title,
  revision: value.revision,
  archived: value.archived,
  lastEvent: value.lastEvent,
  total: value.tasks.filter((task) => !task.archived).length,
  completed: value.tasks.filter(
    (task) => !task.archived && task.status === "completed"
  ).length,
})

export const OriginConversation = Schema.Struct({
  id: ObjectId,
  text: Schema.String,
  answer: Schema.String,
  createdAt: Schema.String,
})
export type OriginConversation = typeof OriginConversation.Type
