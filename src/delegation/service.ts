import { Clock, Context, Effect, Layer, Schema } from "effect"
import { preserveFatal } from "../shared/effect"
import { Control, DelegationFailure } from "./contracts"
import {
  CHILD_LIMIT,
  DURATION_MS,
  validateBrief,
  type DelegationSource,
} from "./delegation"
import type { DelegationAuthority, Delegations } from "./delegations"
import type { DelegationLedger } from "./ledger"
import {
  type SavedGroup,
  acceptControl,
  consumeRequest,
  controlId,
  cut,
  failure,
  missing,
  projectGroup,
  report,
  requestId,
  requireChild,
  requireCurrent,
} from "./domain"

export class Delegation extends Context.Service<Delegation, Delegations>()(
  "durable-pi/delegation/Delegation"
) {}
const decision = <T>(body: () => T) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const delegationFailure =
        Schema.decodeUnknownOption(DelegationFailure)(cause)
      if (delegationFailure._tag === "Some") return delegationFailure.value
      throw cause
    },
  })
const decode = <T>(schema: Schema.ConstraintDecoder<T>, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    preserveFatal,
    Effect.mapError(() =>
      failure("invalid", "Check the delegated task request fields.")
    )
  )

export function makeDelegations(
  ledger: DelegationLedger,
  authority: DelegationAuthority,
  clock: Effect.Effect<number> = Clock.currentTimeMillis
): Delegations {
  const current = (group: SavedGroup) =>
    decision(() => requireCurrent(group, authority))
  const project = (group: SavedGroup) =>
    Effect.gen(function* () {
      const facts = yield* ledger.facts(group)
      const now = yield* clock
      return projectGroup(group, facts, authority.cancelled(group.turnId), now)
    })
  const deliverOne = Effect.fn("Delegation.deliverControl")(function* (
    input: Control
  ) {
    if ((yield* ledger.operation(input.operationId))?.applied) return
    const group = yield* ledger.group(input.groupId)
    yield* current(group)
    const child = group.children.find((value) => value.id === input.childId)
    if (!child) return yield* missing()
    const now = yield* clock
    if (
      input.action.type === "steer" &&
      (child.stopped || now >= group.deadline)
    )
      return
    if (
      input.action.type === "steer" &&
      !(yield* ledger.hasSubmission(child.id, requestId(group, child.id)))
    )
      return
    if (input.action.type === "stop") yield* ledger.abort(child.id)
    else {
      yield* decision(() => requireChild(group, child.id, now))
      yield* ledger.submit(child.id, input.action.text, controlId(input), true)
    }
    yield* ledger.atomic((tx) =>
      Effect.gen(function* () {
        ;(yield* tx.operation(input.operationId)).applied = true
      })
    )
  })
  const deliver = (input: Control) =>
    Effect.gen(function* () {
      const group = yield* ledger.group(input.groupId)
      for (const control of group.controls) {
        if (control.childId === input.childId) yield* deliverOne(control)
        if (control.operationId === input.operationId) break
      }
    })
  const reconcile = (group: SavedGroup) =>
    Effect.gen(function* () {
      if (authority.cancelled(group.turnId) || (yield* clock) >= group.deadline)
        for (const child of group.children) yield* ledger.abort(child.id)
      else for (const control of group.controls) yield* deliver(control)
    })
  return {
    run: Effect.fn("Delegation.run")(function* (raw, source: DelegationSource) {
      const input = yield* decision(() => validateBrief(raw))
      const available = yield* ledger.availableTools()
      if (
        input.tasks.some((task) =>
          task.tools.some((tool) => !available.includes(tool))
        )
      )
        return yield* failure(
          "invalid",
          "A selected child tool is unavailable."
        )
      const group = yield* ledger.atomic((tx) =>
        Effect.gen(function* () {
          const owner = yield* tx.owner(source.taskId)
          if (
            !owner ||
            owner.conversationId !== source.conversationId ||
            owner.abortRequested
          )
            return yield* failure(
              "cancelled",
              "Delegation no longer belongs to the running parent."
            )
          const parent = yield* tx.parent(source.turnId)
          if (parent.group && parent.group !== source.taskId)
            return yield* failure(
              "limit",
              "This request already has a delegation group. Inspect that group or start a new request."
            )
          const document = yield* tx.group(source.taskId)
          if (document.value) {
            if (
              document.value.turnId !== source.turnId ||
              document.value.conversationId !== source.conversationId
            )
              return yield* failure(
                "conflict",
                "Delegation identity belongs to a different parent request."
              )
            if (JSON.stringify(document.value.input) !== JSON.stringify(input))
              return yield* failure(
                "conflict",
                "Delegation identity was reused with a different brief."
              )
            return document.value
          }
          const now = yield* clock
          const saved: SavedGroup = {
            id: source.taskId,
            turnId: source.turnId,
            conversationId: source.conversationId,
            input,
            route: source.route,
            memory: source.memory,
            createdAt: now,
            deadline: now + DURATION_MS,
            revision: 0,
            closed: false,
            children: [],
            controls: [],
          }
          yield* current(saved)
          const children = []
          for (const task of input.tasks)
            children.push({
              ...task,
              tools: [...task.tools],
              id: yield* tx.createChild(source, task),
              requests: 0,
              stopped: false,
            })
          const value = { ...saved, children }
          const catalog = yield* tx.catalog()
          yield* current(value)
          document.value = value
          parent.group = value.id
          catalog.ids.push(value.id)
          return value
        })
      )
      if (group.closed) return report(yield* project(group))
      yield* current(group)
      yield* Effect.forEach(
        group.children,
        (child) =>
          Effect.gen(function* () {
            const latest = yield* ledger.group(group.id)
            yield* current(latest)
            if (
              latest.children.find((value) => value.id === child.id)?.stopped ||
              (yield* clock) >= latest.deadline
            )
              return
            const submission = yield* ledger.submit(
              child.id,
              child.task,
              requestId(group, child.id),
              false
            )
            yield* reconcile(yield* ledger.group(group.id))
            yield* ledger.wait(submission)
          }),
        { concurrency: CHILD_LIMIT, discard: true }
      )
      for (;;) {
        const saved = yield* ledger.group(group.id)
        yield* current(saved)
        yield* reconcile(saved)
        for (const control of saved.controls.filter(
          (value) => value.action.type === "steer"
        ))
          yield* ledger.waitRequest(control.childId, controlId(control))
        const view = yield* project(saved)
        if (
          view.children.some((child) =>
            ["queued", "working", "stopping"].includes(child.status)
          )
        )
          return yield* failure(
            "unavailable",
            "Child work is still settling; resume the same group."
          )
        const sealed = yield* ledger.atomic((tx) =>
          Effect.gen(function* () {
            const document = yield* tx.group(group.id)
            const latest = document.value
            if (!latest) return yield* missing()
            yield* current(latest)
            if (latest.revision !== saved.revision) return false
            const now = yield* clock
            document.value = {
              ...latest,
              closed: true,
              children: latest.children.map((child) => ({
                ...child,
                stopped: child.stopped || now >= latest.deadline,
              })),
              revision: latest.revision + 1,
            }
            return true
          })
        )
        if (sealed) return report(view)
      }
    }),
    list: Effect.fn("Delegation.list")(function* (offset = 0) {
      if (!Number.isSafeInteger(offset) || offset < 0)
        return yield* failure("invalid", "Invalid task offset.")
      const ids = yield* ledger.catalog()
      return yield* Effect.forEach(
        ids
          .slice()
          .reverse()
          .slice(offset, offset + 20),
        (id) => Effect.flatMap(ledger.group(id), project),
        { concurrency: 3 }
      )
    }),
    read: (id) => Effect.flatMap(ledger.group(id), project),
    control: Effect.fn("Delegation.control")(function* (raw) {
      const input = yield* decode(Control, raw)
      const accepted = yield* ledger.atomic((tx) =>
        Effect.gen(function* () {
          const operation = yield* tx.operation(input.operationId)
          const serialized = JSON.stringify(input)
          if (operation.input) {
            if (operation.input !== serialized)
              return yield* failure(
                "conflict",
                "This control identifier belongs to another operation."
              )
            return false
          }
          const document = yield* tx.group(input.groupId)
          if (!document.value) return yield* missing()
          const now = yield* clock
          const group = document.value
          const next = yield* decision(() =>
            acceptControl(group, input, now, authority)
          )
          operation.input = serialized
          document.value = next
          return true
        })
      )
      const group = yield* ledger.group(input.groupId)
      if (
        !group.closed &&
        authority.current(group.turnId, group.conversationId)
      )
        yield* deliver(input)
      return { accepted }
    }),
    transcript: Effect.fn("Delegation.transcript")(
      function* (groupId, childId, cursor) {
        const group = yield* ledger.group(groupId)
        if (!group.children.some((child) => child.id === childId))
          return yield* missing()
        const before = cursor ? Number(cursor) : undefined
        if (
          before !== undefined &&
          (!Number.isSafeInteger(before) || before < 1)
        )
          return yield* failure("invalid", "Invalid transcript position.")
        const page = yield* ledger.transcript(childId, before)
        return {
          ...page,
          entries: page.entries.map((entry) => ({
            ...entry,
            text: cut(entry.text, 16000),
          })),
        }
      }
    ),
    root: Effect.fn("Delegation.root")(function* (id) {
      const parent = yield* ledger.child(id)
      if (!parent) return undefined
      const group = yield* ledger.group(parent)
      yield* current(group)
      const now = yield* clock
      yield* decision(() => requireChild(group, id, now))
      return group.turnId
    }),
    request: Effect.fn("Delegation.request")(function* (id) {
      const binding = yield* ledger.provider(id)
      if (!binding?.group) return
      yield* ledger.atomic((tx) =>
        Effect.gen(function* () {
          const document = yield* tx.group(binding.group)
          if (!document.value) return yield* missing()
          const group = document.value
          const now = yield* clock
          document.value = yield* decision(() =>
            consumeRequest(group, binding.child, now, authority)
          )
        })
      )
    }),
    reconcile: Effect.fn("Delegation.reconcile")(function* (turn) {
      const parent = yield* ledger.parent(turn)
      if (parent) {
        const group = yield* ledger.group(parent)
        if (!group.closed) yield* reconcile(group)
      }
    }),
  }
}
export const delegationApplication = (
  ledger: DelegationLedger,
  authority: DelegationAuthority
) => Layer.succeed(Delegation, makeDelegations(ledger, authority))
