import { Schema } from "effect"

export const RoutineId = Schema.String.check(
  Schema.isPattern(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
  )
)
const text = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
const revision = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
)
const time = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 8640000000000000 })
)
export const RoutineSchedule = Schema.Union([
  Schema.Struct({ type: Schema.Literal("webhook") }),
  Schema.Struct({ type: Schema.Literal("once"), at: time }),
  Schema.Struct({
    type: Schema.Literal("interval"),
    at: time,
    minutes: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 15, maximum: 10080 })
    ),
  }),
])
export type RoutineSchedule = typeof RoutineSchedule.Type
export const RoutineStatus = Schema.Literals(["active", "paused", "archived"])
export const Routine = Schema.Struct({
  id: RoutineId,
  title: text(80),
  prompt: text(12000),
  schedule: RoutineSchedule,
  status: RoutineStatus,
  revision,
  nextAt: Schema.NullOr(time),
  createdAt: time,
  updatedAt: time,
})
export type Routine = typeof Routine.Type
export const RoutineRun = Schema.Struct({
  id: RoutineId,
  routineId: RoutineId,
  routineRevision: revision,
  title: text(80),
  prompt: text(40000),
  turnId: RoutineId,
  trigger: Schema.Literals(["scheduled", "manual", "webhook"]),
  scheduledAt: time,
  createdAt: time,
  status: Schema.Literals(["pending", "queued", "done", "failed", "cancelled"]),
  deadline: Schema.NullOr(time),
  finishedAt: Schema.NullOr(time),
  error: Schema.NullOr(Schema.String),
})
export type RoutineRun = typeof RoutineRun.Type
export const RoutineList = Schema.Struct({
  routines: Schema.Array(Routine),
  runs: Schema.Array(RoutineRun),
})
export type RoutineList = typeof RoutineList.Type
export const SaveRoutine = Schema.Struct({
  id: RoutineId,
  operationId: RoutineId,
  expectedRevision: revision,
  title: text(80),
  prompt: text(12000),
  schedule: RoutineSchedule,
  status: Schema.Literals(["active", "paused"]),
})
export type SaveRoutine = typeof SaveRoutine.Type
export const SetRoutineStatus = Schema.Struct({
  id: RoutineId,
  operationId: RoutineId,
  expectedRevision: revision,
  status: RoutineStatus,
})
export type SetRoutineStatus = typeof SetRoutineStatus.Type
export const RunRoutineNow = Schema.Struct({
  id: RoutineId,
  operationId: RoutineId,
  expectedRevision: revision,
})
export type RunRoutineNow = typeof RunRoutineNow.Type
export const RoutineChange = Schema.Struct({
  routine: Routine,
  run: Schema.NullOr(RoutineRun),
})
export type RoutineChange = typeof RoutineChange.Type
export class RoutineConflict extends Schema.TaggedError<RoutineConflict>()(
  "RoutineConflict",
  { message: Schema.String }
) {}
export const ROUTINE_BUDGET_MS = 10 * 60_000

/** Coalesce missed intervals instead of replaying an unbounded backlog. */
export function followingTime(
  schedule: RoutineSchedule,
  due: number,
  now: number
): number | null {
  if (schedule.type !== "interval") return null
  const interval = schedule.minutes * 60_000
  return due + (Math.floor(Math.max(0, now - due) / interval) + 1) * interval
}
