import { expect, it } from "@effect/vitest"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer } from "effect"

import { BotConfigurationStore } from "../src/agents/adapters/configuration"
import { homeAgentId } from "../src/agents/domain"
import { conversationTransactions } from "../src/conversations/adapters/sqlite-journal"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import {
  guardedMessageAdmission,
  messageAdmission,
  type MessageAdmissionHost,
} from "../src/conversations/admission"
import { makeConversations } from "../src/conversations/service"
import { resolveRoute } from "../src/inference/policy"
import { SkillStore } from "../src/skills/adapters/sqlite"
import { workspaceLayer } from "../src/workspace/adapters/storage"
import { WorkspaceAdmission } from "../src/workspace/admission"
import type { FileError } from "../src/workspace/files"
import { Workspace } from "../src/workspace/workspace"
import { database, corrupt } from "./database"
import { catalog } from "./inference-fixture"

const profile = {
  id: homeAgentId,
  name: "Test",
  instructions: "",
  revision: 0,
  status: "active" as const,
  createdAt: "legacy",
  updatedAt: "legacy",
}
const fixture = Effect.gen(function* () {
  const db = database(),
    configuration = new BotConfigurationStore(db),
    skills = new SkillStore(db),
    ledger = new ConversationStore(db, {
      model: "gpt-6.1-sol",
      thinking: "medium",
    })
  Effect.runSync(configuration.configure("owner", profile))
  const objects = new Map<string, Uint8Array>()
  const layer = workspaceLayer(
    db,
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
    "test"
  )
  const context = yield* Layer.build(layer),
    workspace = Context.get(context, Workspace),
    files = Context.get(context, WorkspaceAdmission),
    conversations = makeConversations(ledger)
  const effects: MessageAdmissionHost<FileError> = {
    connected: () => Effect.succeed(true),
    archived: () =>
      Effect.succeed(
        Effect.runSync(configuration.read())?.status === "archived"
      ),
    catalog: () => Effect.succeed(catalog),
    wake: () =>
      Effect.sync(() => {
        wakes++
      }),
    notify: () =>
      Effect.sync(() => {
        notifications++
      }),
  }
  let wakes = 0,
    notifications = 0
  const commit = guardedMessageAdmission(
    ledger,
    configuration,
    files,
    skills,
    conversationTransactions(db)
  )
  return {
    db,
    configuration,
    skills,
    ledger,
    conversations,
    workspace,
    files,
    effects,
    commit,
    layer,
    admit: messageAdmission(conversations, workspace, commit, effects),
    counters: () => ({ wakes, notifications }),
  }
})
const input = () => ({ operationId: crypto.randomUUID(), text: "A message" })
const failure = (tag: string) => ({ _tag: "Failure", failure: { _tag: tag } })

it.effect(
  "rechecks file eligibility inside admission after model discovery",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        file = yield* f.workspace.upload({
          id: crypto.randomUUID(),
          name: "notes.txt",
          mime: "text/plain",
          bytes: new TextEncoder().encode("Notes"),
        })
      f.effects.catalog = () =>
        f.workspace.trash(file.id, true).pipe(Effect.as(catalog))
      expect(
        yield* f.admit({ ...input(), files: [file.id] }).pipe(Effect.result)
      ).toMatchObject(failure("FileNotFound"))
      expect(Effect.runSync(f.ledger.recent())).toEqual([])
      expect(f.counters()).toEqual({ wakes: 0, notifications: 0 })
    })
)
it.effect(
  "fences steering against a replacement active reply after discovery",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        root = Effect.runSync(f.ledger.admit(input())).turn
      f.effects.catalog = () =>
        Effect.sync(() => {
          Effect.runSync(
            f.ledger.finish(
              root,
              [{ id: root.id, delivery: "answered" }],
              "Done",
              null
            )
          )
          Effect.runSync(f.ledger.admit(input()))
          return catalog
        })
      const steer = { ...input(), mode: "steer" as const }
      expect(yield* f.admit(steer).pipe(Effect.result)).toMatchObject(
        failure("ConversationConflict")
      )
      expect(Effect.runSync(f.ledger.get(steer.operationId))).toBeUndefined()
      expect(f.counters().wakes).toBe(0)
    })
)
it.effect(
  "rejects a mixed database graph before any transaction or write",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      let transactions = 0
      const commit = guardedMessageAdmission(
        f.ledger,
        f.configuration,
        { ...f.files, transactionGroup: {} },
        f.skills,
        {
          transactionGroup: f.db,
          atomic: (body) => {
            transactions++
            return body()
          },
        }
      )
      expect(
        yield* commit(
          input(),
          { files: [], content: [] },
          resolveRoute("conversation"),
          null,
          catalog
        ).pipe(Effect.result)
      ).toMatchObject(failure("ConversationConflict"))
      expect(transactions).toBe(0)
      expect(Effect.runSync(f.ledger.recent())).toEqual([])
    })
)
it.effect("leaves no turn or wake after a native admission write failure", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    f.db.run(
      "CREATE TRIGGER reject_turn BEFORE INSERT ON chat_turns BEGIN SELECT RAISE(ABORT,'private storage data'); END"
    )
    expect(yield* f.admit(input()).pipe(Effect.result)).toMatchObject(
      failure("ConversationStorageError")
    )
    expect(Effect.runSync(f.ledger.recent())).toEqual([])
    expect(f.counters()).toEqual({ wakes: 0, notifications: 0 })
  })
)
it.effect(
  "exact replay bypasses new connection, archive and file checks and re-arms committed work",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        file = yield* f.workspace.upload({
          id: crypto.randomUUID(),
          name: "notes.txt",
          mime: "text/plain",
          bytes: new TextEncoder().encode("Notes"),
        }),
        submission = { ...input(), files: [file.id] }
      expect(yield* f.admit(submission)).toMatchObject({ accepted: true })
      yield* f.workspace.trash(file.id, true)
      Effect.runSync(
        f.configuration.configure("owner", {
          ...profile,
          revision: 1,
          status: "archived",
        })
      )
      f.effects.connected = () => Effect.succeed(false)
      f.effects.catalog = () => Effect.die("replay must not discover models")
      expect(yield* f.admit(submission)).toMatchObject({
        accepted: false,
        operationId: submission.operationId,
      })
      expect(Effect.runSync(f.ledger.recent())).toHaveLength(1)
      expect(f.counters()).toEqual({ wakes: 2, notifications: 1 })
    })
)
it.effect(
  "a concurrent exact admission wins before stale model validation and archive checks",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        submission = input()
      f.effects.catalog = () =>
        Effect.sync(() => {
          Effect.runSync(f.ledger.admit(submission))
          Effect.runSync(
            f.configuration.configure("owner", {
              ...profile,
              revision: 1,
              status: "archived",
            })
          )
          return { ...catalog, models: [] }
        })
      expect(yield* f.admit(submission)).toMatchObject({
        accepted: false,
        operationId: submission.operationId,
      })
      expect(Effect.runSync(f.ledger.recent())).toHaveLength(1)
      expect(f.counters().wakes).toBe(1)
    })
)
it.effect(
  "preserves caller Context and typed discovery failures without committing",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      class RequestValue extends Context.Service<
        RequestValue,
        { value: string }
      >()("test/AdmissionRequest") {}
      const admit = messageAdmission<
        FileError | { _tag: "DiscoveryFailure"; value: string },
        RequestValue
      >(f.conversations, f.workspace, f.commit, {
        ...f.effects,
        catalog: () =>
          Effect.gen(function* () {
            const request = yield* RequestValue
            return yield* Effect.fail({
              _tag: "DiscoveryFailure" as const,
              value: request.value,
            })
          }),
      })
      expect(
        yield* admit(input()).pipe(
          Effect.provideService(RequestValue, { value: "current invocation" }),
          Effect.result
        )
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "DiscoveryFailure", value: "current invocation" },
      })
      expect(Effect.runSync(f.ledger.recent())).toEqual([])
    })
)
it.effect(
  "keeps a malformed file record as a defect and a native read failure typed",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        file = yield* f.workspace.upload({
          id: crypto.randomUUID(),
          name: "notes.txt",
          mime: "text/plain",
          bytes: new TextEncoder().encode("Notes"),
        })
      corrupt(
        f.db,
        "UPDATE workspace_files SET kind='invalid' WHERE id=?",
        file.id
      )
      const exit = yield* f.workspace.requireFiles([file.id]).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
      f.db.run("DROP TABLE workspace_files")
      expect(
        yield* f.workspace.requireFiles([file.id]).pipe(Effect.result)
      ).toMatchObject(failure("WorkspaceUnavailable"))
    })
)
it.effect("independent builds retain the native transaction identity", () =>
  Effect.gen(function* () {
    const f = yield* fixture,
      second = yield* Layer.build(f.layer)
    expect(Context.get(second, WorkspaceAdmission).transactionGroup).toBe(f.db)
    expect(f.files.transactionGroup).toBe(f.db)
  })
)
it.effect(
  "a canceled discovery cannot commit or wake after it is released",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      f.effects.catalog = () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(catalog)
        )
      const pending = yield* f.admit(input()).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(pending)
      yield* Deferred.succeed(release, undefined)
      expect(Effect.runSync(f.ledger.recent())).toEqual([])
      expect(f.counters()).toEqual({ wakes: 0, notifications: 0 })
    })
)

it.effect("rejects an unavailable model before durable admission", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    f.effects.catalog = () => Effect.succeed({ ...catalog, models: [] })
    expect(yield* f.admit(input()).pipe(Effect.result)).toMatchObject(
      failure("ModelUnavailable")
    )
    expect(Effect.runSync(f.ledger.recent())).toEqual([])
    expect(f.counters()).toEqual({ wakes: 0, notifications: 0 })
  })
)
it.effect(
  "interruption after the durable claim waits for scheduling and notification",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture,
        entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>(),
        submission = input()
      let settled = false
      f.effects.wake = () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release))
        )
      const pending = yield* f.admit(submission).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            settled = true
          })
        ),
        Effect.forkChild
      )
      yield* Deferred.await(entered)
      expect(Effect.runSync(f.ledger.get(submission.operationId))?.status).toBe(
        "queued"
      )
      const interruption = yield* Fiber.interrupt(pending).pipe(
        Effect.forkChild
      )
      yield* Effect.yieldNow
      expect(settled).toBe(false)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(interruption)
      const exit = yield* Fiber.await(pending)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(settled).toBe(true)
      expect(f.counters().notifications).toBe(1)
      expect(Effect.runSync(f.ledger.recent())).toHaveLength(1)
    })
)
