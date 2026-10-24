import { createEffectActor, send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Schema, Scope } from "effect"
import type { EventFromLogic } from "xstate"

import { ApiError } from "@/http/client"
import {
  ObjectDetail,
  ObjectList,
  ObjectMutation,
  MutationReceipt,
  type ObjectSummary,
} from "@/objects/contracts"
import { orDieAll } from "@/shared/effect"
import { nativeOperation } from "@/shared/interop"

import {
  objectEditMachine,
  type ObjectDraft,
  type ObjectProblem,
} from "./object-edit.machine"
import { objectPollMachine } from "./object-poll.machine"
import { objectReadMachine } from "./object-read.machine"
import {
  readObjectDrafts,
  writeObjectDrafts,
  type ObjectStorage,
} from "./object-storage"

type EditMachine = ReturnType<typeof objectEditMachine>
type ReadMachine = ReturnType<typeof objectReadMachine>
type EditEvent = EventFromLogic<EditMachine>
type State = {
  list: readonly ObjectSummary[]
  details: Record<string, ObjectDetail>
  pending: Record<string, ObjectMutation>
  busy: Record<string, boolean>
  editing: Record<string, boolean>
  problems: Record<string, ObjectProblem | undefined>
  saved: Record<string, string>
  confirmed: Record<string, number>
  settled: Record<string, true>
  error: string
}
const message = (cause: unknown, fallback: string) => {
  const error = Cause.isCause(cause)
    ? cause.reasons.find((x) => x._tag === "Fail")
    : undefined
  const value = error ? error.error : cause
  return value instanceof Error ? value.message : fallback
}
const problem = (
  cause: Cause.Cause<unknown>,
  input: ObjectMutation
): ObjectProblem => {
  const failures = cause.reasons.filter((x) => x._tag === "Fail")
  const error = failures.length === 1 ? failures[0]!.error : undefined
  const definite =
    !Cause.hasDies(cause) &&
    !Cause.hasInterrupts(cause) &&
    error instanceof ApiError &&
    [400, 401, 403, 404, 409].includes(error.status)
  return {
    kind: definite
      ? error.status === 409
        ? "conflict"
        : "error"
      : "uncertain",
    message: message(cause, "Save not confirmed. Retry this same change."),
    input,
  }
}
type Acknowledgements = {
  on: (
    type: "settled",
    listener: (event: { id: string; ok: boolean }) => void
  ) => { unsubscribe: () => void }
  subscribe: (observer: { complete: () => void; error: () => void }) => {
    unsubscribe: () => void
  }
}
function acknowledged(
  actor: Acknowledgements,
  id: string,
  dispatch: () => Promise<void>
) {
  let finish!: (ok: boolean) => void
  const promise = new Promise<boolean>((resolve) => {
    finish = resolve
  })
  const result = actor.on("settled", (event) => {
    if (event.id === id) finish(event.ok)
  })
  const stopped = actor.subscribe({
    complete: () => finish(false),
    error: () => finish(false),
  })
  void dispatch().catch(() => finish(false))
  return promise.finally(() => {
    result.unsubscribe()
    stopped.unsubscribe()
  })
}
/** React owns this scope; every per-object actor and native request is its child.
 * The external-store snapshot is only a projection, never mutation authority. */
export class ObjectStore {
  private state: State = {
    list: [],
    details: {},
    pending: {},
    busy: {},
    editing: {},
    problems: {},
    saved: {},
    confirmed: {},
    settled: {},
    error: "",
  }
  private listeners = new Set<() => void>()
  private scope = Effect.runSync(Scope.make())
  private edits = new Map<string, Promise<EffectActor<EditMachine>>>()
  private reads = new Map<string, Promise<EffectActor<ReadMachine>>>()
  private records = new Map<string, ObjectDraft>()
  private poller?: Promise<EffectActor<ReturnType<typeof objectPollMachine>>>
  private storage?: ObjectStorage
  private storageError = ""
  private connected = false
  private disposed = false
  private closing?: Promise<void>
  private failures: Cause.Cause<unknown>[] = []
  constructor(
    private api: <T>(
      path: string,
      body?: unknown,
      signal?: AbortSignal
    ) => Promise<T>,
    private key: string
  ) {
    Effect.runSync(
      Scope.addFinalizer(
        this.scope,
        Effect.suspend(() => {
          const reasons = this.failures.flatMap((cause) => cause.reasons)
          return reasons.length
            ? Effect.failCause(Cause.fromReasons(reasons)).pipe(orDieAll)
            : Effect.void
        })
      )
    )
  }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private set(patch: Partial<State>) {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((listener) => listener())
  }
  connect(storage: ObjectStorage) {
    if (this.connected || this.disposed) return
    this.connected = true
    this.storage = storage
    try {
      const drafts = readObjectDrafts(storage.getItem(this.key))
      this.records = new Map(drafts.map((draft) => [draft.input.id, draft]))
      this.set({
        pending: Object.fromEntries(
          drafts
            .filter((draft) => draft.pending)
            .map((draft) => [draft.input.id, draft.input])
        ),
        problems: Object.fromEntries(
          drafts.map((draft) => [draft.input.id, draft.problem ?? undefined])
        ),
      })
    } catch {
      this.storageError =
        "Saved browser drafts could not be read. Keep this browser session; saving is blocked until a compatible version can recover them. Your server checklists are unchanged."
      this.set({ error: this.storageError })
    }
  }
  private retain(id: string, draft: ObjectDraft | null) {
    return Effect.try({
      try: () => {
        if (this.storageError) throw new Error(this.storageError)
        if (!this.storage)
          throw new Error(
            "Browser session storage is unavailable. Reopen this page to save safely."
          )
        const records = new Map(this.records)
        if (draft) records.set(id, draft)
        else records.delete(id)
        this.storage.setItem(this.key, writeObjectDrafts([...records.values()]))
        this.records = records
      },
      catch: (cause) => cause,
    })
  }
  private request(path: string, body?: unknown) {
    return nativeOperation(
      (signal) => this.api(path, body, signal),
      (cause) => cause
    ).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit) && Cause.hasDies(exit.cause))
            this.failures.push(exit.cause)
        })
      )
    )
  }
  private editOwner(id: string) {
    let owner = this.edits.get(id)
    if (!owner) {
      owner = Effect.runPromise(
        createEffectActor(
          objectEditMachine({
            retain: (draft) => this.retain(id, draft),
            problem,
            save: (input) =>
              this.request("objects/mutate", input).pipe(
                Effect.map(
                  Schema.decodeUnknownSync(
                    MutationReceipt.check(
                      Schema.makeFilter(
                        (receipt) =>
                          receipt.objectId === id || "Unexpected save receipt."
                      )
                    )
                  )
                )
              ),
            cancel: (operationId) =>
              this.request("objects/cancel", { operationId }).pipe(
                Effect.map(
                  Schema.decodeUnknownSync(
                    Schema.Struct({ applied: Schema.Boolean })
                  )
                )
              ),
          }),
          { input: this.records.get(id) ?? null }
        ).pipe(Effect.provideService(Scope.Scope, this.scope))
      ).then((actor) => {
        actor.subscribe((snapshot) => {
          const value = snapshot.context,
            draft = value.draft
          const pending = { ...this.state.pending }
          if (draft?.pending) pending[id] = draft.input
          else delete pending[id]
          this.set({
            pending,
            busy: { ...this.state.busy, [id]: !snapshot.matches("ready") },
            editing: { ...this.state.editing, [id]: value.editing },
            problems: {
              ...this.state.problems,
              [id]: draft?.problem ?? undefined,
            },
            saved: { ...this.state.saved, [id]: value.saved },
            confirmed: { ...this.state.confirmed, [id]: value.confirmed },
            settled: {
              ...this.state.settled,
              ...Object.fromEntries(
                value.settled.map((operation) => [operation, true as const])
              ),
            },
          })
        })
        return actor
      })
      this.edits.set(id, owner)
    }
    return owner
  }
  private async edit(id: string, event: (request: string) => EditEvent) {
    if (this.disposed || this.storageError) return false
    const actor = await this.editOwner(id)
    if (this.disposed) return false
    const request = crypto.randomUUID()
    return acknowledged(actor, request, () =>
      Effect.runPromise(send(actor, event(request)))
    )
  }
  private readOwner(key: string, accept: (raw: unknown) => void) {
    let owner = this.reads.get(key)
    if (!owner) {
      owner = Effect.runPromise(
        createEffectActor(objectReadMachine((path) => this.request(path))).pipe(
          Effect.provideService(Scope.Scope, this.scope)
        )
      ).then((actor) => {
        actor.subscribe((snapshot) => {
          if (this.disposed || !snapshot.matches("idle")) return
          if (snapshot.context.failure)
            this.set({
              error:
                this.storageError ||
                message(
                  snapshot.context.failure,
                  "Could not reconnect to checklists."
                ),
            })
          else if (snapshot.context.value !== undefined) {
            try {
              accept(snapshot.context.value)
            } catch (error) {
              this.set({
                error:
                  this.storageError ||
                  message(error, "Unexpected checklist response."),
              })
            }
          }
        })
        return actor
      })
      this.reads.set(key, owner)
    }
    return owner
  }
  private async read(
    key: string,
    path: string,
    accept: (raw: unknown) => void
  ) {
    if (this.disposed) return
    const actor = await this.readOwner(key, accept)
    if (this.disposed) return
    const request = crypto.randomUUID()
    await acknowledged(actor, request, () =>
      Effect.runPromise(send(actor, { type: "READ", path, request }))
    )
  }
  private accept(detail: ObjectDetail) {
    const old = this.state.details[detail.object.id]
    if (old && old.object.revision > detail.object.revision) return
    const events = [...detail.events, ...(old?.events ?? [])]
      .filter(
        (event, index, all) =>
          all.findIndex((item) => item.id === event.id) === index
      )
      .sort((a, b) => b.revision - a.revision)
    const contiguous = events.filter(
      (event, index) => event.revision === detail.object.revision - index
    )
    const last = contiguous.at(-1)?.revision ?? detail.object.revision
    this.set({
      details: {
        ...this.state.details,
        [detail.object.id]: {
          ...detail,
          events: contiguous,
          nextHistory: last > 1 ? last : null,
        },
      },
    })
  }
  refresh = () =>
    this.read("list", "objects", (raw) => {
      const { objects } = Schema.decodeUnknownSync(ObjectList)(raw)
      const merged = objects.map((object) => {
        const old = this.state.list.find((item) => item.id === object.id)
        return old && old.revision >= object.revision ? old : object
      })
      if (
        (this.state.error && !this.storageError) ||
        merged.length !== this.state.list.length ||
        merged.some((object, index) => object !== this.state.list[index])
      )
        this.set({ list: merged, error: this.storageError })
    })
  load = (id: string, _fresh = false) =>
    this.read(`detail:${id}`, `objects/${id}`, (raw) => {
      const detail = Schema.decodeUnknownSync(ObjectDetail)(raw)
      if (detail.object.id !== id)
        throw new Error("The response belongs to another checklist.")
      this.accept(detail)
    })
  async history(id: string) {
    const before = this.state.details[id]?.nextHistory
    if (!before) return
    await this.read(
      `history:${id}:${before}`,
      `objects/${id}?before=${before}`,
      (raw) => {
        const page = Schema.decodeUnknownSync(ObjectDetail)(raw),
          current = this.state.details[id]
        if (page.object.id !== id || !current || current.nextHistory !== before)
          return
        const events = [...current.events, ...page.events].filter(
          (event, index, all) =>
            all.findIndex((item) => item.id === event.id) === index
        )
        this.set({
          details: {
            ...this.state.details,
            [id]: { ...current, events, nextHistory: page.nextHistory },
          },
        })
      }
    )
  }
  async submit(input: ObjectMutation) {
    if (this.disposed || this.storageError) return false
    let valid: ObjectMutation
    try {
      valid = Schema.decodeUnknownSync(ObjectMutation)(input)
    } catch {
      return false
    }
    const ok = await this.edit(valid.id, (request) => ({
      type: "SUBMIT",
      request,
      input: valid,
    }))
    await this.load(valid.id, true)
    if (ok) await this.refresh()
    return ok
  }
  async retry(id: string) {
    const ok = await this.edit(id, (request) => ({ type: "RETRY", request }))
    await this.load(id, true)
    if (ok) await this.refresh()
    return ok
  }
  async reapply(id: string) {
    const current = this.state.details[id]?.object
    if (!current) return false
    const ok = await this.edit(id, (request) => ({
      type: "REAPPLY",
      request,
      operationId: crypto.randomUUID(),
      revision: current.revision,
      archived: current.archived,
    }))
    await this.load(id, true)
    if (ok) await this.refresh()
    return ok
  }
  async cancel(id: string) {
    const ok = await this.edit(id, (request) => ({ type: "CANCEL", request }))
    await this.load(id, true)
    if (ok) await this.refresh()
  }
  dismiss = (id: string) =>
    this.edit(id, (request) => ({ type: "DISMISS", request }))
  async beginEdit(id: string) {
    if (this.disposed) return
    const actor = await this.editOwner(id)
    if (!this.disposed) await Effect.runPromise(send(actor, { type: "EDIT" }))
  }
  async cancelEdit(id: string) {
    await this.dismiss(id)
  }
  async observe(active: boolean, visible: boolean) {
    if (this.disposed) return
    this.poller ??= Effect.runPromise(
      createEffectActor(
        objectPollMachine(() =>
          Effect.promise(async () => {
            await this.refresh()
            await Promise.all(
              Object.keys(this.state.details).map((id) => this.load(id))
            )
          })
        )
      ).pipe(Effect.provideService(Scope.Scope, this.scope))
    )
    const actor = await this.poller
    if (!this.disposed)
      await Effect.runPromise(send(actor, { type: "OBSERVE", active, visible }))
  }
  async reconnect() {
    if (this.disposed || !this.poller) return
    const actor = await this.poller
    if (!this.disposed)
      await Effect.runPromise(send(actor, { type: "REFRESH" }))
  }
  dispose() {
    if (this.closing) return this.closing
    this.disposed = true
    this.closing = Promise.allSettled([
      ...this.edits.values(),
      ...this.reads.values(),
      ...(this.poller ? [this.poller] : []),
    ]).then(async () => {
      const exit = await Effect.runPromiseExit(
        Scope.close(this.scope, Exit.void)
      )
      if (Exit.isFailure(exit)) throw exit.cause
    })
    return this.closing
  }
}
