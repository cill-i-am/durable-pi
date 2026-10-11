import { Schema } from "effect"
import { ApiError } from "@/http/client"
import {
  ObjectDetail,
  ObjectList,
  ObjectMutation,
  MutationReceipt,
  type ObjectSummary,
} from "@/objects/contracts"

type Problem = {
  kind: "conflict" | "uncertain" | "error"
  message: string
  input: ObjectMutation
}
type State = {
  list: readonly ObjectSummary[]
  details: Record<string, ObjectDetail>
  pending: Record<string, ObjectMutation>
  busy: Record<string, boolean>
  problems: Record<string, Problem | undefined>
  saved: Record<string, string>
  confirmed: Record<string, number>
  settled: Record<string, true>
  error: string
}
type Storage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/** One shared view for chat/workbench. Server revisions, never optimistic copies, win. */
export class ObjectStore {
  private state: State = {
    list: [],
    details: {},
    pending: {},
    busy: {},
    problems: {},
    saved: {},
    confirmed: {},
    settled: {},
    error: "",
  }
  private listeners = new Set<() => void>()
  private storage?: Storage
  private inflight = new Map<string, Promise<void>>()
  private replacements = new Map<string, string[]>()
  constructor(
    private api: <T>(path: string, body?: unknown) => Promise<T>,
    private key: string
  ) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((listener) => listener())
  }
  private settle(operationId: string) {
    const ids = [operationId, ...(this.replacements.get(operationId) ?? [])]
    this.set({
      settled: {
        ...this.state.settled,
        ...Object.fromEntries(ids.map((id) => [id, true as const])),
      },
    })
    this.replacements.delete(operationId)
  }
  async reapply(id: string) {
    const problem = this.state.problems[id],
      current = this.state.details[id]?.object
    if (
      problem?.kind !== "conflict" ||
      !current ||
      current.archived ||
      this.state.pending[id] ||
      this.state.busy[id]
    )
      return false
    const operationId = crypto.randomUUID()
    this.replacements.set(operationId, [
      problem.input.operationId,
      ...(this.replacements.get(problem.input.operationId) ?? []),
    ])
    return this.submit({
      ...problem.input,
      operationId,
      expectedRevision: current.revision,
    })
  }
  connect(storage: Storage) {
    this.storage = storage
    try {
      const pending = Schema.decodeUnknownSync(Schema.Array(ObjectMutation))(
        JSON.parse(storage.getItem(this.key) ?? "[]")
      )
      this.set({
        pending: Object.fromEntries(pending.map((input) => [input.id, input])),
        problems: Object.fromEntries(
          pending.map((input) => [
            input.id,
            {
              kind: "uncertain",
              message:
                "A previous save was not confirmed. Retry the same change or cancel it safely.",
              input,
            },
          ])
        ),
      })
    } catch {
      this.set({
        error:
          "Saved browser drafts could not be read. Your server checklists are unchanged.",
      })
    }
  }
  private retain(pending: State["pending"]) {
    // Persist before sending. A browser restart must retain the original retry identity.
    if (!this.storage)
      throw new Error(
        "Browser session storage is unavailable. Reopen this page to save safely."
      )
    this.storage.setItem(this.key, JSON.stringify(Object.values(pending)))
    this.set({ pending })
  }
  private accept(detail: ObjectDetail) {
    const old = this.state.details[detail.object.id]
    if (!old || old.object.revision <= detail.object.revision) {
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
  }
  async refresh() {
    try {
      const { objects } = Schema.decodeUnknownSync(ObjectList)(
        await this.api("objects")
      )
      // Detail responses and list responses can arrive out of order.
      const merged = objects.map((object) => {
        const old = this.state.list.find((item) => item.id === object.id)
        return old && old.revision > object.revision ? old : object
      })
      this.set({ list: merged, error: "" })
    } catch (error) {
      this.set({
        error:
          error instanceof Error
            ? error.message
            : "Could not reconnect to checklists.",
      })
    }
  }
  load(id: string, fresh = false): Promise<void> {
    const existing = this.inflight.get(id)
    if (existing) return fresh ? existing.then(() => this.load(id)) : existing
    const promise = this.api(`objects/${id}`)
      .then((raw) => this.accept(Schema.decodeUnknownSync(ObjectDetail)(raw)))
      .catch((error) => {
        this.set({
          error:
            error instanceof Error
              ? error.message
              : "Could not load this checklist.",
        })
      })
      .finally(() => this.inflight.delete(id))
    this.inflight.set(id, promise)
    return promise
  }
  async history(id: string) {
    const before = this.state.details[id]?.nextHistory
    if (!before) return
    try {
      const page = Schema.decodeUnknownSync(ObjectDetail)(
        await this.api(`objects/${id}?before=${before}`)
      )
      const current = this.state.details[id]
      if (!current || current.nextHistory !== before) return
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
    } catch {
      this.set({ error: "Could not load more history. Try again." })
    }
  }
  async submit(input: ObjectMutation): Promise<boolean> {
    if (this.state.pending[input.id] || this.state.busy[input.id]) return false
    try {
      this.retain({
        ...this.state.pending,
        [input.id]: Schema.decodeUnknownSync(ObjectMutation)(input),
      })
    } catch (error) {
      this.set({
        problems: {
          ...this.state.problems,
          [input.id]: {
            kind: "error",
            message:
              error instanceof Error ? error.message : "Check your fields.",
            input,
          },
        },
      })
      return false
    }
    return this.retry(input.id)
  }
  async retry(id: string): Promise<boolean> {
    const input = this.state.pending[id]
    if (!input || this.state.busy[id]) return false
    this.set({
      busy: { ...this.state.busy, [id]: true },
      problems: { ...this.state.problems, [id]: undefined },
    })
    try {
      const receipt = Schema.decodeUnknownSync(MutationReceipt)(
        await this.api("objects/mutate", input)
      )
      if (receipt.objectId !== id) throw new Error("Unexpected save receipt.")
      const pending = { ...this.state.pending }
      delete pending[id]
      this.retain(pending)
      this.set({
        saved: { ...this.state.saved, [id]: input.operationId },
        confirmed: {
          ...this.state.confirmed,
          [id]: Math.max(this.state.confirmed[id] ?? 0, receipt.revision),
        },
      })
      this.settle(input.operationId)
      await this.load(id, true)
      await this.refresh()
      return true
    } catch (error) {
      const definite =
        error instanceof ApiError &&
        [400, 401, 403, 404, 409].includes(error.status)
      if (definite) {
        const pending = { ...this.state.pending }
        delete pending[id]
        try {
          this.retain(pending)
        } catch {
          /* Keep the original retry on disk; it still cannot duplicate a change. */
        }
      }
      this.set({
        problems: {
          ...this.state.problems,
          [id]: {
            kind:
              error instanceof ApiError && error.status === 409
                ? "conflict"
                : definite
                  ? "error"
                  : "uncertain",
            message:
              error instanceof Error
                ? error.message
                : "Save not confirmed. Retry this same change.",
            input,
          },
        },
      })
      await this.load(id, true)
      return false
    } finally {
      this.set({ busy: { ...this.state.busy, [id]: false } })
    }
  }
  async cancel(id: string) {
    const input = this.state.pending[id]
    if (!input || this.state.busy[id]) return
    this.set({ busy: { ...this.state.busy, [id]: true } })
    try {
      const result = await this.api<{ applied: boolean }>("objects/cancel", {
        operationId: input.operationId,
      })
      const pending = { ...this.state.pending }
      delete pending[id]
      this.retain(pending)
      this.set({
        problems: { ...this.state.problems, [id]: undefined },
        saved: result.applied
          ? { ...this.state.saved, [id]: input.operationId }
          : this.state.saved,
      })
      this.settle(input.operationId)
      await this.load(id, true)
      await this.refresh()
    } catch {
      this.set({
        problems: {
          ...this.state.problems,
          [id]: {
            kind: "uncertain",
            message:
              "Could not confirm cancellation. Keep this change until you reconnect.",
            input,
          },
        },
      })
    } finally {
      this.set({ busy: { ...this.state.busy, [id]: false } })
    }
  }
  dismiss(id: string) {
    if (!this.state.pending[id]) {
      const operationId = this.state.problems[id]?.input.operationId
      if (operationId) this.settle(operationId)
      this.set({ problems: { ...this.state.problems, [id]: undefined } })
    }
  }
}
