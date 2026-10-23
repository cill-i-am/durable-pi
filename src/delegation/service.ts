import { createEffectActor, waitFor } from "@xstate/effect"
import {
  Cause,
  Clock,
  Context,
  Effect,
  Equal,
  Exit,
  Layer,
  Ref,
  Schema,
  Semaphore,
} from "effect"

import { attributedText } from "../messages/identity"
import { preserveFatal } from "../shared/effect"
import { advanceChildDispatch } from "./child-dispatch.machine"
import { Control, DelegationFailure } from "./contracts"
import {
  CHILD_LIMIT,
  DURATION_MS,
  validateBrief,
  type DelegationSource,
} from "./delegation"
import type {
  DelegationAuthority,
  DelegationRecovery,
  Delegations,
} from "./delegations"
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
  restoreGroup,
} from "./domain"
import { advanceChild, advanceGroup } from "./group.machine"
import type { DelegationLedger, DelegationTransaction } from "./ledger"
import { localDispatchMachine } from "./local-dispatch.machine"

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
  clock: Effect.Effect<number> = Clock.currentTimeMillis,
  recovery?: DelegationRecovery
): Delegations {
  const read = <TValue>(
    body: () => TValue | Effect.Effect<TValue, DelegationFailure>
  ) =>
    Effect.suspend(() => {
      const value = body()
      return Effect.isEffect(value) ? value : Effect.succeed(value)
    })
  const snapshot = (group: SavedGroup) =>
    Effect.gen(function* () {
      const current = yield* read(() =>
        authority.current(group.turnId, group.conversationId)
      )
      const cancelled = yield* read(() => authority.cancelled(group.turnId))
      return { current: () => current, cancelled: () => cancelled }
    })
  const current = (group: SavedGroup) =>
    Effect.flatMap(snapshot(group), (facts) =>
      decision(() => requireCurrent(group, facts))
    )
  const project = (group: SavedGroup) =>
    Effect.gen(function* () {
      const facts = yield* ledger.facts(group)
      const now = yield* clock
      return projectGroup(
        group,
        facts,
        yield* read(() => authority.cancelled(group.turnId)),
        now
      )
    })
  // These entries contain only scoped native work, never business authority.
  // Every application route to a child holds the same permit until native
  // settlement and its receipt are joined. Stop revokes in storage before join.
  const owners = new Map<
    number,
    { permit: Semaphore.Semaphore; users: number }
  >()
  const owned = <A>(child: number, work: Effect.Effect<A, DelegationFailure>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const owner = owners.get(child) ?? {
          permit: Semaphore.makeUnsafe(1),
          users: 0,
        }
        owner.users++
        owners.set(child, owner)
        return owner
      }),
      (owner) => owner.permit.withPermit(work),
      (owner) =>
        Effect.sync(() => {
          if (--owner.users === 0) owners.delete(child)
        })
    )
  const arm = () =>
    recovery ? recovery.arm() : clock.pipe(Effect.map((now) => now + 60_000))
  const requireDiscovery = (deadline: number) =>
    clock.pipe(
      Effect.flatMap((now) =>
        Number.isFinite(deadline) && now < deadline
          ? Effect.void
          : failure(
              "unavailable",
              "Agent recovery discovery expired before acceptance. Retry the same operation."
            )
      )
    )
  const wake = () => (recovery ? recovery.wake() : Effect.void)
  const writeDispatch = (
    groupId: number,
    request: string,
    event: Parameters<typeof advanceChildDispatch>[1]
  ) =>
    ledger.atomic((tx) =>
      Effect.gen(function* () {
        const document = yield* tx.group(groupId)
        if (!document.value) return yield* missing()
        const group = document.value
        const command = group.dispatches?.find(
          (value) => value.request === request
        )
        if (!command) return yield* missing()
        const next = yield* decision(() => advanceChildDispatch(command, event))
        if (JSON.stringify(next) === JSON.stringify(command)) return
        document.value = {
          ...group,
          revision: group.revision + 1,
          dispatches: group.dispatches!.map((value) =>
            value.request === request ? next : value
          ),
        }
      })
    )
  const dispatch = (groupId: number, request: string) =>
    Effect.gen(function* () {
      const group = yield* ledger.group(groupId)
      const command = group.dispatches?.find(
        (value) => value.request === request
      )
      if (!command) return yield* missing()
      yield* owned(
        command.childId,
        Effect.gen(function* () {
          const failures = yield* Ref.make<Cause.Cause<DelegationFailure>[]>([])
          const observe = <A>(work: Effect.Effect<A, DelegationFailure>) =>
            work.pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? Ref.update(failures, (all) => [...all, exit.cause])
                  : Effect.void
              )
            )
          yield* Effect.gen(function* () {
            const actor = yield* createEffectActor(
              localDispatchMachine({
                claim: observe(
                  Effect.gen(function* () {
                    // A cold lost acknowledgement recovers the original native receipt;
                    // it never changes the request key or authorizes another attempt.
                    const receipt = yield* ledger.submission(
                      command.childId,
                      request
                    )
                    if (receipt !== undefined) {
                      yield* writeDispatch(groupId, request, {
                        type: "ACCEPTED",
                        receipt,
                      })
                      return undefined
                    }
                    return yield* ledger.atomic((tx) =>
                      Effect.gen(function* () {
                        const document = yield* tx.group(groupId)
                        if (!document.value) return yield* missing()
                        const latest = document.value
                        const saved = latest.dispatches!.find(
                          (value) => value.request === request
                        )!
                        if (["confirmed", "rejected"].includes(saved.state))
                          return undefined
                        const facts = yield* snapshot(latest)
                        const now = yield* clock
                        const child = latest.children.find(
                          (value) => value.id === saved.childId
                        )
                        const authorized =
                          !latest.closed &&
                          latest.lifecycle === "open" &&
                          !!child &&
                          !child.stopped &&
                          now < latest.deadline &&
                          (latest.detached
                            ? !facts.cancelled()
                            : facts.current())
                        const next = yield* decision(() =>
                          advanceChildDispatch(saved, {
                            type: "CLAIM",
                            authorized,
                          })
                        )
                        if (JSON.stringify(next) !== JSON.stringify(saved))
                          document.value = {
                            ...latest,
                            revision: latest.revision + 1,
                            dispatches: latest.dispatches!.map((value) =>
                              value.request === request ? next : value
                            ),
                          }
                        return authorized ? next : undefined
                      })
                    )
                  })
                ),
                submit: (input) =>
                  observe(
                    ledger
                      .submit(
                        input.childId,
                        input.text,
                        input.request,
                        input.steer
                      )
                      .pipe(
                        Effect.onExit((exit) =>
                          Exit.isFailure(exit)
                            ? writeDispatch(groupId, request, {
                                type: "UNCERTAIN",
                              }).pipe(Effect.uninterruptible)
                            : Effect.void
                        )
                      )
                  ),
                record: (_, receipt) =>
                  observe(
                    writeDispatch(groupId, request, {
                      type: "ACCEPTED",
                      receipt,
                    })
                  ),
              })
            )
            const done = yield* waitFor(
              actor,
              (state) => state.status === "done"
            ).pipe(Effect.orDie)
            return yield* done.output!
          }).pipe(
            Effect.scoped,
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                if (!Exit.isFailure(exit) || !Cause.hasInterrupts(exit.cause))
                  return
                const retained = exit.cause.reasons
                const missing = (yield* Ref.get(failures)).flatMap((cause) =>
                  cause.reasons.filter(
                    (reason) =>
                      reason._tag !== "Interrupt" &&
                      !retained.some((present) => Equal.equals(present, reason))
                  )
                )
                if (missing.length)
                  return yield* Effect.failCause(Cause.fromReasons(missing))
              })
            )
          )
        })
      )
    })
  const childEvent = (
    groupId: number,
    child: number,
    event: Parameters<typeof advanceChild>[2]
  ) =>
    ledger.atomic((tx) =>
      Effect.gen(function* () {
        const document = yield* tx.group(groupId)
        if (!document.value) return yield* missing()
        document.value = yield* decision(() =>
          advanceChild(document.value!, child, event)
        )
      })
    )
  const stopChild = (groupId: number, child: number, retry = false) =>
    owned(
      child,
      Effect.gen(function* () {
        const group = yield* ledger.group(groupId)
        const target = group.children.find((value) => value.id === child)
        if (!target?.stopped || target.lifecycle === "stopped") return
        if (target.lifecycle === "unconfirmed") {
          if (!retry) return
          yield* childEvent(groupId, child, { type: "STOP" })
        }
        yield* ledger
          .abort(child)
          .pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? childEvent(groupId, child, { type: "UNCERTAIN" }).pipe(
                    Effect.uninterruptible
                  )
                : Effect.void
            )
          )
        yield* childEvent(groupId, child, { type: "CONFIRMED" })
      })
    )
  const deliverOne = Effect.fn("Delegation.deliverControl")(function* (
    input: Control
  ) {
    const group = yield* ledger.group(input.groupId)
    if (input.action.type === "stop") {
      // A legacy applied flag did not own pending dispatch. Child cleanup is
      // independently restored and must be acknowledged before closing.
      yield* stopChild(group.id, input.childId, true)
    } else {
      if ((yield* ledger.operation(input.operationId))?.applied) return
      if (
        !(yield* ledger.hasSubmission(
          input.childId,
          requestId(group, input.childId)
        ))
      )
        return
      yield* dispatch(group.id, controlId(input))
      const latest = yield* ledger.group(group.id)
      if (
        latest.dispatches?.find((value) => value.request === controlId(input))
          ?.state !== "confirmed"
      )
        return
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
  const revokeGroup = (tx: DelegationTransaction, id: number) =>
    Effect.gen(function* () {
      const document = yield* tx.group(id)
      if (!document.value || document.value.closed) return
      let next = document.value
      for (const child of next.children)
        if (!child.stopped)
          next = yield* decision(() =>
            advanceChild(next, child.id, { type: "STOP" })
          )
      document.value = yield* decision(() =>
        advanceGroup(next, { type: "REVOKE" })
      )
    })
  const reconcile = (original: SavedGroup, allowDispatch = true) =>
    Effect.gen(function* () {
      let group = yield* ledger.group(original.id)
      const revoked =
        (yield* clock) >= group.deadline ||
        (allowDispatch &&
          (yield* read(() => authority.cancelled(group.turnId))))
      if (revoked) {
        yield* ledger.atomic((tx) => revokeGroup(tx, group.id))
        group = yield* ledger.group(group.id)
      }
      for (const child of group.children)
        if (child.stopped) yield* stopChild(group.id, child.id)
      for (const command of group.dispatches ?? []) {
        if (allowDispatch && (group.detached || command.steer))
          yield* dispatch(group.id, command.request)
      }
      for (const control of group.controls) {
        if (!allowDispatch && control.action.type !== "stop") continue
        const latest = yield* ledger.group(group.id)
        if (
          control.action.type === "stop" &&
          latest.children.find((child) => child.id === control.childId)
            ?.lifecycle === "unconfirmed"
        )
          continue
        yield* deliverOne(control)
      }
      yield* ledger.atomic((tx) =>
        Effect.gen(function* () {
          const document = yield* tx.group(group.id)
          if (document.value && !document.value.closed)
            document.value = yield* decision(() =>
              advanceGroup(document.value!, { type: "CLEANED" })
            )
        })
      )
    })
  const requireGroupCapacity = (
    tx: DelegationTransaction,
    ids: readonly number[],
    _now: number
  ) =>
    Effect.gen(function* () {
      let live = 0
      for (const id of ids) {
        const previous = (yield* tx.group(id)).value
        if (
          previous?.detached &&
          !previous.closed &&
          previous.lifecycle !== "closed"
        )
          live++
      }
      if (live >= 3)
        return yield* failure(
          "limit",
          "Three agent groups are already open in this bot."
        )
    })
  return {
    revoke: Effect.fn("Delegation.revoke")(function* (turn) {
      // A known access/parent revocation is a durable fact. It does not require
      // renewed authority, a discovery lease, an operation identity or native IO.
      yield* ledger.atomic((tx) =>
        Effect.gen(function* () {
          const parent = yield* tx.parent(turn)
          if (parent.group) yield* revokeGroup(tx, parent.group)
        })
      )
    }),
    nextWake: () =>
      Effect.gen(function* () {
        const now = yield* clock
        let next: number | undefined
        for (const id of yield* ledger.catalog()) {
          const group = yield* ledger.group(id)
          const cleanup = group.children.some(
            (child) => child.lifecycle === "stopping"
          )
          const active =
            group.detached &&
            !group.closed &&
            group.children.some((child) => !child.stopped)
          if (cleanup || active)
            next = Math.min(
              next ?? Infinity,
              Math.max(now, Math.min(now + 1000, group.deadline))
            )
        }
        return next
      }),
    restore: () =>
      Effect.gen(function* () {
        for (const id of yield* ledger.catalog()) {
          const group = yield* ledger.group(id)
          if (
            (group.detached && !group.closed) ||
            group.children.some((child) => child.lifecycle === "stopping")
          )
            yield* reconcile(group, false)
        }
      }),
    exhaustRecovery: (isCurrent) =>
      Effect.gen(function* () {
        for (const id of yield* ledger.catalog()) {
          if (!isCurrent()) return
          yield* ledger.atomic((tx) =>
            Effect.gen(function* () {
              const document = yield* tx.group(id)
              if (!document.value || document.value.closed || !isCurrent())
                return
              let group = document.value
              for (const child of group.children) {
                if (!child.stopped)
                  group = yield* decision(() =>
                    advanceChild(group, child.id, { type: "STOP" })
                  )
                group = yield* decision(() =>
                  advanceChild(group, child.id, { type: "UNCERTAIN" })
                )
              }
              document.value = yield* decision(() =>
                advanceGroup(group, { type: "REVOKE" })
              )
            })
          )
        }
      }),
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
      const discoveryDeadline = source.detached ? yield* arm() : undefined
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
            if (
              JSON.stringify(document.value.input) !== JSON.stringify(input) ||
              !!document.value.detached !== !!source.detached
            )
              return yield* failure(
                "conflict",
                "Delegation identity was reused with a different brief."
              )
            if (discoveryDeadline !== undefined)
              yield* requireDiscovery(discoveryDeadline)
            return document.value
          }
          const now = yield* clock
          if (
            !(yield* read(() =>
              authority.current(source.turnId, source.conversationId)
            ))
          )
            return yield* failure("cancelled", "The parent request has ended.")
          const catalog = yield* tx.catalog()
          if (source.detached) yield* requireGroupCapacity(tx, catalog.ids, now)
          const saved: SavedGroup = {
            ...(source.botId ? { botId: source.botId } : {}),
            ...(source.detached ? { detached: true } : {}),
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
          const value = restoreGroup({ ...saved, children })
          yield* current(value)
          if (discoveryDeadline !== undefined)
            yield* requireDiscovery(discoveryDeadline)
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
            yield* dispatch(group.id, requestId(group, child.id))
            yield* reconcile(yield* ledger.group(group.id))
            const submission = yield* ledger.submission(
              child.id,
              requestId(group, child.id)
            )
            if (!group.detached && submission !== undefined)
              yield* ledger.wait(submission)
          }),
        { concurrency: CHILD_LIMIT, discard: true }
      )
      if (group.detached) {
        yield* wake()
        return JSON.stringify({
          groupId: group.id,
          sessionId: group.turnId,
          status: "accepted",
          agents: group.children.map((child) => ({
            sessionId: group.turnId,
            agentId: String(child.id),
            name: child.name,
          })),
          deadline: group.deadline,
        })
      }
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
            document.value = yield* decision(() =>
              advanceGroup(latest, { type: "SETTLED" })
            )
            if (!document.value.closed) return false
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
      const discoveryDeadline =
        input.action.type === "steer" ? yield* arm() : undefined
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
            if (discoveryDeadline !== undefined)
              yield* requireDiscovery(discoveryDeadline)
            return false
          }
          const document = yield* tx.group(input.groupId)
          if (!document.value) return yield* missing()
          const now = yield* clock
          const group = document.value
          const facts =
            input.action.type === "steer"
              ? yield* snapshot(group)
              : { current: () => false, cancelled: () => false }
          const next = yield* decision(() =>
            acceptControl(group, input, now, facts)
          )
          if (discoveryDeadline !== undefined)
            yield* requireDiscovery(discoveryDeadline)
          operation.input = serialized
          document.value =
            input.action.type === "steer"
              ? {
                  ...next,
                  dispatches: [
                    ...(next.dispatches ?? []),
                    {
                      request: controlId(input),
                      childId: input.childId,
                      text: attributedText(input.action.text, input.provenance),
                      steer: true,
                      state: "accepted" as const,
                    },
                  ],
                }
              : next
          return true
        })
      )
      if (input.action.type === "stop") {
        // Stop revokes durably even when discovery is unavailable. Cleanup is
        // a joined finalizer, so scheduler failure/interruption cannot skip it
        // and neither scheduler nor cleanup fatal causes are discarded.
        yield* arm().pipe(
          Effect.flatMap(requireDiscovery),
          Effect.andThen(wake()),
          Effect.onExit(() => deliver(input))
        )
      } else {
        yield* wake()
        yield* deliver(input)
      }
      return { accepted }
    }),
    deliverMessage: Effect.fn("Delegation.deliverMessage")(
      function* (childId, text, request) {
        if (!request || !text)
          return yield* failure(
            "invalid",
            "A child message requires its original identity and text."
          )
        const groupId = yield* ledger.child(childId)
        if (!groupId) return yield* missing()
        const discoveryDeadline = yield* arm()
        yield* ledger.atomic((tx) =>
          Effect.gen(function* () {
            const document = yield* tx.group(groupId)
            if (!document.value) return yield* missing()
            const group = document.value
            const existing = group.dispatches?.find(
              (value) => value.request === request
            )
            if (existing) {
              if (
                existing.childId !== childId ||
                existing.text !== text ||
                !existing.steer
              )
                return yield* failure(
                  "conflict",
                  "This child message identifier belongs to different content."
                )
              yield* requireDiscovery(discoveryDeadline)
              return
            }
            yield* current(group)
            const now = yield* clock
            yield* decision(() => requireChild(group, childId, now))
            yield* requireDiscovery(discoveryDeadline)
            document.value = {
              ...group,
              revision: group.revision + 1,
              dispatches: [
                ...(group.dispatches ?? []),
                {
                  request,
                  childId,
                  text,
                  steer: true,
                  state: "accepted" as const,
                },
              ],
            }
          })
        )
        yield* wake()
        yield* dispatch(groupId, request)
        const latest = yield* ledger.group(groupId)
        const result = latest.dispatches?.find(
          (value) => value.request === request
        )
        if (result?.state !== "confirmed")
          return yield* failure(
            result?.state === "rejected" ? "cancelled" : "unavailable",
            "Child message delivery could not be confirmed. Retry the same operation."
          )
      }
    ),
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
          const facts = yield* snapshot(group)
          document.value = yield* decision(() =>
            consumeRequest(group, binding.child, now, facts)
          )
        })
      )
    }),
    reconcile: Effect.fn("Delegation.reconcile")(function* (turn, options) {
      const parent = yield* ledger.parent(turn)
      if (parent) {
        const group = yield* ledger.group(parent)
        if (
          !group.closed ||
          group.children.some((child) => child.lifecycle === "stopping")
        )
          yield* reconcile(group, options?.allowDispatch !== false)
      }
    }),
  }
}
export const delegationApplication = (
  ledger: DelegationLedger,
  authority: DelegationAuthority,
  recovery: DelegationRecovery
) =>
  Layer.succeed(
    Delegation,
    makeDelegations(ledger, authority, undefined, recovery)
  )
