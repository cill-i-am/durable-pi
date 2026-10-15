import {
  RoutineConflict,
  type Routine,
  type RoutineRun,
  type SaveRoutine,
  type SetRoutineStatus,
} from "./contracts"

export function currentRoutine(
  routine: Routine | undefined,
  expected: number
): Routine {
  if (!routine || routine.revision !== expected)
    throw new RoutineConflict({
      message: "This routine changed. Reload before making this change.",
    })
  return routine
}

export function saveRoutine(
  input: SaveRoutine,
  previous: Routine | undefined,
  all: readonly Routine[],
  pending: RoutineRun | undefined,
  now: number
): Routine {
  if (previous) currentRoutine(previous, input.expectedRevision)
  else if (input.expectedRevision !== 0 || all.length >= 50)
    throw new RoutineConflict({
      message:
        "Cannot create this routine. Each bot supports 50 saved routines.",
    })
  if (previous?.status === "archived")
    throw new RoutineConflict({
      message: "Restore this routine before editing it.",
    })
  if (!input.title.trim() || !input.prompt.trim())
    throw new RoutineConflict({
      message: "Give the routine a name and instructions.",
    })
  if (
    all.some(
      (value) =>
        value.id !== input.id &&
        value.status !== "archived" &&
        value.title.toLowerCase() === input.title.trim().toLowerCase()
    )
  )
    throw new RoutineConflict({
      message: "A routine with this name already exists. Edit it instead.",
    })
  const rescheduled =
    !previous ||
    JSON.stringify(previous.schedule) !== JSON.stringify(input.schedule)
  if (
    rescheduled &&
    input.schedule.type !== "webhook" &&
    (input.schedule.at <= now || input.schedule.at > now + 366 * 86400000)
  )
    throw new RoutineConflict({
      message: "Choose a first run in the coming year.",
    })
  return {
    id: input.id,
    title: input.title.trim(),
    prompt: input.prompt.trim(),
    schedule: input.schedule,
    status: input.status,
    revision: (previous?.revision ?? 0) + 1,
    nextAt: rescheduled
      ? input.schedule.type === "webhook"
        ? null
        : input.schedule.at
      : pending?.trigger === "scheduled"
        ? pending.scheduledAt
        : previous.nextAt,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  }
}

export function changeRoutineStatus(
  input: SetRoutineStatus,
  current: Routine,
  all: readonly Routine[],
  pending: RoutineRun | undefined,
  now: number
): Routine {
  if (
    input.status !== "archived" &&
    all.some(
      (value) =>
        value.id !== input.id &&
        value.status !== "archived" &&
        value.title.toLowerCase() === current.title.toLowerCase()
    )
  )
    throw new RoutineConflict({
      message: "Another active routine uses this name.",
    })
  return {
    ...current,
    status: input.status,
    revision: current.revision + 1,
    updatedAt: now,
    nextAt:
      pending?.trigger === "scheduled" ? pending.scheduledAt : current.nextAt,
  }
}

export const pendingFor = (run: RoutineRun | undefined, id: string) =>
  run?.routineId === id && run.status === "pending" ? run : undefined

export const admissionAllowed = (
  routine: Routine | undefined,
  run: RoutineRun
) =>
  !!routine &&
  routine.status !== "archived" &&
  routine.revision === run.routineRevision &&
  (run.trigger !== "scheduled" || routine.status === "active")

export const dueRoutine = (all: readonly Routine[], now: number) =>
  all
    .filter(
      (value) =>
        value.status === "active" &&
        value.nextAt !== null &&
        value.nextAt <= now
    )
    .sort((a, b) => a.nextAt! - b.nextAt!)[0]

export const canRun = (
  run: RoutineRun | undefined,
  turnId: string,
  now: number
) => run?.turnId !== turnId || run.deadline === null || run.deadline > now

export function nextWake(
  all: readonly Routine[],
  run: RoutineRun | undefined,
  now: number
) {
  if (run) return now + (run.status === "pending" ? 60_000 : 5000)
  return all
    .filter((value) => value.status === "active" && value.nextAt !== null)
    .reduce<number | undefined>(
      (earliest, value) =>
        earliest === undefined
          ? value.nextAt!
          : Math.min(earliest, value.nextAt!),
      undefined
    )
}
