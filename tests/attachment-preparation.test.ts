import { expect, it } from "@effect/vitest"
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
} from "effect"

import { BotConfigurationStore } from "../src/agents/adapters/configuration"
import { homeAgentId } from "../src/agents/domain"
import { conversationTransactions } from "../src/conversations/adapters/sqlite-journal"
import {
  guardedMessageAdmission,
  messageAdmission,
} from "../src/conversations/admission"
import { resumeAttachments } from "../src/conversations/attachments"
import { conversationPump } from "../src/conversations/pump"
import { SkillStore } from "../src/skills/adapters/sqlite"
import { workspaceLayer } from "../src/workspace/adapters/storage"
import { WorkspaceAdmission } from "../src/workspace/admission"
import { prepareAttachments } from "../src/workspace/attachments"
import { DocumentUnreadable } from "../src/workspace/documents"
import { FileRejected } from "../src/workspace/files"
import { Workspace } from "../src/workspace/workspace"
import { conversationFixture } from "./conversation-fixture"
import { catalog } from "./inference-fixture"

const profile = {
  id: homeAgentId,
  slug: "test",
  name: "Test",
  instructions: "",
  revision: 0,
  status: "active" as const,
  createdAt: "legacy",
  updatedAt: "legacy",
}
const fixture = Effect.gen(function* () {
  const f = yield* conversationFixture(),
    configuration = new BotConfigurationStore(f.db),
    skills = new SkillStore(f.db)
  yield* configuration.configure("owner", profile)
  const objects = new Map<string, Uint8Array>(),
    state = { unreadable: false, calls: 0 }
  const context = yield* Layer.build(
    workspaceLayer(
      f.db,
      {
        put: async (key, bytes) => {
          objects.set(key, bytes)
        },
        get: async (key) => {
          const bytes = objects.get(key)
          return bytes
            ? {
                body: new Blob([new Uint8Array(bytes)]).stream(),
                arrayBuffer: async () => new Uint8Array(bytes).buffer,
              }
            : null
        },
      },
      "attachments",
      () => Effect.succeed(true),
      {
        document: () =>
          Effect.gen(function* () {
            state.calls++
            if (state.unreadable)
              return yield* new DocumentUnreadable({ reason: "encrypted" })
            return {
              text: "[Page 1] PREPARED_DOCUMENT_MARKER",
              pages: 1,
              readPages: 1,
              truncated: false,
            }
          }),
        video: () =>
          Effect.succeed({
            duration: 1,
            frames: [{ at: 0, jpeg: "/9j/" }],
            captions: "Prepared video",
            captionsTruncated: false,
          }),
      }
    )
  )
  const workspace = Context.get(context, Workspace),
    files = Context.get(context, WorkspaceAdmission),
    storage = conversationTransactions(f.db)
  const admit = messageAdmission(
    f.conversations,
    workspace,
    guardedMessageAdmission(f.store, configuration, files, skills, storage),
    {
      connected: () => Effect.succeed(true),
      archived: () =>
        configuration.read().pipe(Effect.map((c) => c?.status === "archived")),
      prearm: () => Effect.sync(() => Date.now() + 60_000),
      catalog: () => Effect.succeed(catalog),
      wake: () => Effect.void,
      notify: () => Effect.void,
    }
  )
  const resume = resumeAttachments(
    f.store,
    workspace,
    configuration,
    files,
    storage
  )
  const pump = conversationPump(
    f.conversations,
    f.memory,
    f.journal,
    f.execution,
    { ...f.host, prepareFiles: resume }
  )
  const pdf = () =>
    workspace.upload({
      id: crypto.randomUUID(),
      name: "brief.pdf",
      mime: "application/pdf",
      bytes: new TextEncoder().encode("%PDF-synthetic"),
    })
  return {
    ...f,
    workspace,
    configuration,
    files,
    storage,
    state,
    admit,
    resume,
    pump,
    pdf,
  }
})

for (const surface of ["web", "email", "whatsapp"] as const) {
  it.effect(
    `durably accepts ${surface} files once, then resumes the same request after preparation`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture,
          file = yield* f.pdf(),
          id = crypto.randomUUID()
        const origin =
          surface === "web"
            ? undefined
            : surface === "email"
              ? {
                  kind: "email" as const,
                  sender: "owner@example.com",
                  subject: "Read PDF",
                }
              : {
                  kind: "whatsapp" as const,
                  sender: "12345678",
                  messageId: "wamid.test",
                }
        const input = {
          operationId: id,
          text: "Read this PDF",
          files: [file.id],
          origin,
        }
        expect(yield* f.admit(input)).toMatchObject({
          accepted: true,
          operationId: id,
        })
        expect(yield* f.admit(input)).toMatchObject({
          accepted: false,
          operationId: id,
        })
        expect(yield* f.store.get(id)).toMatchObject({
          files_pending: true,
          input: [],
          status: "queued",
        })
        expect(yield* f.pump.run()).toBe(
          (yield* Clock.currentTimeMillis) + 5000
        )
        expect(f.events).toEqual([])
        yield* f.workspace.extractNext()
        // Recreate the coordinator over persisted rows, as after isolate replacement.
        const resume = resumeAttachments(
          f.store,
          f.workspace,
          f.configuration,
          f.files,
          f.storage
        )
        expect(yield* resume((yield* f.store.get(id))!)).toEqual({
          ready: true,
        })
        expect(yield* f.store.get(id)).toMatchObject({
          files_pending: false,
          attachments: [{ id: file.id, extraction: { status: "ready" } }],
        })
        expect(JSON.stringify((yield* f.store.get(id))!.input)).toContain(
          "PREPARED_DOCUMENT_MARKER"
        )
        yield* f.pump.run()
        yield* f.pump.run()
        expect(yield* f.store.get(id)).toMatchObject({ status: "done" })
        expect(f.events.filter((e) => e === "submit")).toHaveLength(1)
        expect(f.state.calls).toBe(1)
      })
  )
}

it.effect(
  "a cancelled request cannot restart when its attachment becomes ready",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        file = yield* f.pdf(),
        id = crypto.randomUUID()
      yield* f.admit({ operationId: id, text: "Read", files: [file.id] })
      const pending = (yield* f.store.get(id))!
      yield* f.store.requestStop(id)
      yield* f.workspace.extractNext()
      expect(yield* f.resume(pending)).toEqual({ ready: false })
      yield* f.pump.run()
      expect(yield* f.store.get(id)).toMatchObject({ status: "cancelled" })
      expect(f.events).not.toContain("submit")
    })
)

it.effect(
  "an unreadable attachment fails the original request with its actual error and needs explicit retry",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        file = yield* f.pdf(),
        id = crypto.randomUUID()
      yield* f.admit({ operationId: id, text: "Read", files: [file.id] })
      f.state.unreadable = true
      yield* f.workspace.extractNext()
      yield* f.pump.run()
      expect(yield* f.store.get(id)).toMatchObject({
        status: "failed",
        error: expect.stringContaining("password protected"),
      })
      expect(f.events).not.toContain("submit")
      expect(yield* prepareAttachments(f.workspace, [file.id])).toMatchObject({
        pending: true,
        error: expect.stringContaining("password protected"),
      })
      expect(yield* f.workspace.extractionPending()).toBe(false)
      f.state.unreadable = false
      yield* f.admit({
        operationId: crypto.randomUUID(),
        retryOf: id,
        text: "Read",
        files: [file.id],
      })
      expect(yield* f.workspace.extractionPending()).toBe(true)
      yield* f.workspace.extractNext()
      yield* f.pump.run()
      expect(f.events.filter((e) => e === "submit")).toHaveLength(1)
    })
)

it.effect(
  "a file that fails before intake is accepted and receives a terminal answer, rather than waiting forever",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        file = yield* f.pdf(),
        id = crypto.randomUUID()
      f.state.unreadable = true
      yield* f.workspace.extractNext()
      expect(
        yield* f.admit({ operationId: id, text: "Read", files: [file.id] })
      ).toMatchObject({ accepted: true })
      yield* f.pump.run()
      expect(yield* f.store.get(id)).toMatchObject({
        status: "failed",
        error: expect.stringContaining("password protected"),
      })
    })
)

it.effect("final eligibility is rechecked after reading prepared bytes", () =>
  Effect.gen(function* () {
    const f = yield* fixture,
      file = yield* f.pdf(),
      id = crypto.randomUUID()
    yield* f.admit({ operationId: id, text: "Read", files: [file.id] })
    yield* f.workspace.extractNext()
    const original = f.workspace.attach
    f.workspace.attach = (ids) =>
      original(ids).pipe(Effect.tap(() => f.workspace.trash(file.id, true)))
    expect(yield* f.resume((yield* f.store.get(id))!)).toMatchObject({
      ready: false,
      error: expect.stringContaining("no longer available"),
    })
    expect(yield* f.store.get(id)).toMatchObject({
      files_pending: true,
      input: [],
    })
  })
)

it.effect(
  "missing video jobs are enqueued and prepared through the same intake module",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        id = crypto.randomUUID(),
        file = yield* f.workspace.upload({
          id: crypto.randomUUID(),
          name: "clip.mp4",
          mime: "video/mp4",
          bytes: Uint8Array.from([0, 0, 0, 12, 102, 116, 121, 112, 0, 0, 0, 0]),
        })
      f.db.run("DELETE FROM workspace_video_preparations WHERE id = ?", file.id)
      yield* f.admit({ operationId: id, text: "Watch", files: [file.id] })
      expect(yield* f.workspace.extractionPending()).toBe(true)
      yield* f.workspace.extractNext()
      yield* f.pump.run()
      expect(f.events).toContain("submit")
    })
)

it.effect(
  "steering preparation holds completion, then submits the prepared steering input",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        root = crypto.randomUUID(),
        steer = crypto.randomUUID()
      yield* f.admit({ operationId: root, text: "Start" })
      yield* f.pump.run()
      const file = yield* f.pdf()
      yield* f.admit({
        operationId: steer,
        text: "Also read",
        mode: "steer",
        files: [file.id],
      })
      yield* f.pump.run()
      expect(yield* f.store.get(root)).toMatchObject({ status: "running" })
      yield* f.workspace.extractNext()
      yield* f.pump.run()
      expect(f.events).toContain(`steer:${steer}`)
      expect(yield* f.store.get(root)).toMatchObject({ status: "done" })
    })
)

it.effect(
  "a failed steering attachment waits for native abort to settle before finishing",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        root = crypto.randomUUID(),
        steer = crypto.randomUUID()
      yield* f.admit({ operationId: root, text: "Start" })
      yield* f.pump.run()
      const file = yield* f.pdf()
      yield* f.admit({
        operationId: steer,
        text: "Read protected file",
        mode: "steer",
        files: [file.id],
      })
      f.state.unreadable = true
      yield* f.workspace.extractNext()
      const observe = f.execution.observe
      let settled = false
      f.execution.observe = (turn, members) =>
        observe(turn, members).pipe(
          Effect.map((reply) => ({ ...reply!, settled }))
        )
      yield* f.pump.run()
      expect(f.events).toContain("abort")
      expect(f.events).not.toContain("completed")
      expect(yield* f.store.get(root)).toMatchObject({ status: "running" })
      settled = true
      yield* f.pump.run()
      expect(yield* f.store.get(root)).toMatchObject({
        status: "failed",
        error: expect.stringContaining("password protected"),
      })
      expect(f.events.filter((e) => e === "submit")).toHaveLength(1)
    })
)

it.effect(
  "prepared files cannot be materialized by a different live root owner",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        file = yield* f.pdf(),
        id = crypto.randomUUID()
      yield* f.admit({ operationId: id, text: "Read", files: [file.id] })
      yield* f.workspace.extractNext()
      const turn = (yield* f.store.get(id))!
      expect(
        yield* f.store.claimControl(
          id,
          "current-owner",
          (yield* Clock.currentTimeMillis) + 60_000
        )
      ).toBeDefined()
      expect(yield* f.resume(turn, "stale-owner")).toEqual({ ready: false })
      expect(yield* f.store.get(id)).toMatchObject({
        files_pending: true,
        input: [],
      })
      expect(yield* f.resume(turn, "current-owner")).toEqual({ ready: true })
      expect(yield* f.store.get(id)).toMatchObject({ files_pending: false })
    })
)

it.effect(
  "attachment rejection with a defect cannot become an ordinary readiness error",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        file = yield* f.pdf(),
        id = crypto.randomUUID()
      yield* f.admit({ operationId: id, text: "Read", files: [file.id] })
      yield* f.workspace.extractNext()
      f.workspace.attach = () =>
        Effect.failCause(
          Cause.combine(
            Cause.fail(new FileRejected({ message: "ordinary rejection" })),
            Cause.die("attachment cleanup defect")
          )
        )
      const exit = yield* f.resume((yield* f.store.get(id))!).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
        "attachment cleanup defect"
      )
      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
        "ordinary rejection"
      )
      expect(yield* f.store.get(id)).toMatchObject({ files_pending: true })
    })
)

it.effect(
  "interrupted attachment preparation joins and retains late cleanup failure",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        file = yield* f.pdf(),
        id = crypto.randomUUID(),
        entered = yield* Deferred.make<void>(),
        cleaning = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      yield* f.admit({ operationId: id, text: "Read", files: [file.id] })
      yield* f.workspace.extractNext()
      f.workspace.attach = () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Deferred.succeed(cleaning, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Effect.die("attachment cleanup failure"))
            )
          )
        )
      const pending = yield* f
        .resume((yield* f.store.get(id))!)
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const interruption = yield* Fiber.interrupt(pending).pipe(
        Effect.forkChild
      )
      yield* Deferred.await(cleaning)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(interruption)
      const exit = yield* Fiber.await(pending)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
        "attachment cleanup failure"
      )
      expect(yield* f.store.get(id)).toMatchObject({ files_pending: true })
    })
)
