import { expect, it } from "@effect/vitest"
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Schema,
} from "effect"
import { TestClock } from "effect/testing"

import { BotConfigurationStore } from "../src/agents/adapters/configuration"
import { agentCatalogRequest } from "../src/agents/adapters/http"
import { SqliteAgentCatalog } from "../src/agents/adapters/sqlite"
import { agentRuntimeReader } from "../src/agents/adapters/statuses"
import {
  agentNativeOperation,
  configurationInput,
  synchronizeTerminalAuthority,
} from "../src/agents/adapters/synchronization"
import {
  archiveAgent,
  configureAgent,
  type AgentConfigurationHost,
  type TerminalAuthorityProjection,
} from "../src/agents/application"
import { AgentCatalog } from "../src/agents/catalog"
import {
  BotConfiguration,
  configurationApplication,
} from "../src/agents/configuration"
import {
  AgentId,
  AgentSynchronizationError,
  agentArchiveChange,
  agentCreationReplay,
  requireAgentCapacity,
  homeAgentId,
  type AgentProfile,
  type AgentConflict,
  type AgentStorageError,
} from "../src/agents/domain"
import { agentCatalogApplication } from "../src/agents/service"
import { agentStatuses } from "../src/agents/statuses"
import { migrateSqlite } from "../src/storage/migrations"
import type { Sqlite } from "../src/storage/sqlite"
import { database, corrupt } from "./database"
import { sqliteFailure } from "./sqlite-fault"

const id = (n: number) =>
  Schema.decodeUnknownSync(AgentId)(
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
  )
const details = (n = 1) => ({
  id: id(n),
  name: " Research ",
  instructions: "Synthetic",
})
const profile = (
  revision = 0,
  status: "active" | "archived" = "active"
): AgentProfile => ({
  ...details(),
  slug: "research",
  status,
  revision,
  createdAt: "old",
  updatedAt: "old",
})
const fixture = (db = database()) =>
  Effect.gen(function* () {
    const ledger = new SqliteAgentCatalog(db)
    const catalog = yield* AgentCatalog.pipe(
      Effect.provide(agentCatalogApplication(ledger))
    )
    const configuration = new BotConfigurationStore(db)
    const configured = yield* BotConfiguration.pipe(
      Effect.provide(configurationApplication(configuration))
    )
    return { db, ledger, catalog, configuration, configured }
  })
function host(
  events: string[],
  projections: TerminalAuthorityProjection[]
): AgentConfigurationHost<never> {
  const event = (value: string) =>
    Effect.sync(() => {
      events.push(value)
    })
  return {
    invalidateApps: () => event("invalidate"),
    syncTerminal: (value) =>
      Effect.sync(() => {
        events.push("terminal")
        projections.push(value)
      }),
    wakeBrowser: () => event("browser"),
    extractionPending: () => Effect.succeed(true),
    wakeExtraction: () => event("extract"),
    appsPending: () => Effect.succeed(true),
    wakeApps: () => event("apps"),
    routinesPending: () => Effect.succeed(true),
    wakeRoutines: () => event("routines"),
  }
}

it.effect(
  "catalog uses invocation Clock, retains raw creation identity, and replays before capacity",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(35000)
      const f = yield* fixture()
      const input = details()
      const created = yield* f.catalog.create(input)
      expect(created).toMatchObject({
        name: "Research",
        revision: 0,
        createdAt: "1970-01-01T00:00:35.000Z",
        updatedAt: "1970-01-01T00:00:35.000Z",
      })
      for (let n = 2; n < 32; n++) yield* f.catalog.create(details(n))
      yield* TestClock.setTime(40000)
      expect(yield* f.catalog.create(input)).toEqual(created)
      expect(
        yield* f.catalog
          .create({ ...input, name: "Research" })
          .pipe(Effect.result)
      ).toMatchObject({ _tag: "Failure", failure: { _tag: "AgentConflict" } })
      expect(
        yield* f.catalog.create(details(32)).pipe(Effect.result)
      ).toMatchObject({ _tag: "Failure", failure: { _tag: "AgentConflict" } })
      expect(
        (yield* f.catalog.list()).some((item) => item.id === homeAgentId)
      ).toBe(true)
    })
)
it.effect(
  "generated archive/capacity policy preserves home and only charges a restored slot",
  () =>
    Effect.sync(() => {
      for (let active = 0; active <= 34; active++) {
        if (active >= 32) expect(() => requireAgentCapacity(active)).toThrow()
        else expect(() => requireAgentCapacity(active)).not.toThrow()
        expect(agentArchiveChange(profile(1, "active"), false, active)).toBe(
          "active"
        )
        expect(agentArchiveChange(profile(1, "archived"), true, active)).toBe(
          "archived"
        )
        if (active >= 32)
          expect(() =>
            agentArchiveChange(profile(1, "archived"), false, active)
          ).toThrow()
        else
          expect(
            agentArchiveChange(profile(1, "archived"), false, active)
          ).toBe("active")
      }
      expect(() =>
        agentArchiveChange({ ...profile(), id: homeAgentId }, true, 0)
      ).toThrow("original")
      expect(agentCreationReplay(undefined, "key")).toBe(false)
      expect(agentCreationReplay("key", "key")).toBe(true)
      expect(() => agentCreationReplay("", "key")).toThrow("another bot")
    })
)
it.effect(
  "catalog write and outer commit failures roll back publication and revisions",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.catalog.create(details())
      f.db.run(
        "CREATE TRIGGER reject_profile BEFORE UPDATE ON agent_catalog BEGIN SELECT RAISE(ABORT,'private SQL detail'); END"
      )
      expect(
        yield* f.catalog.archive(id(1), true).pipe(Effect.result)
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "AgentStorageError" },
      })
      expect(yield* f.catalog.requireActive(id(1))).toMatchObject({
        revision: 0,
        status: "active",
      })
      f.db.run("DROP TRIGGER reject_profile")
      let failCommit = false
      const failing: Sqlite = {
        ...f.db,
        transaction: (body) =>
          f.db.transaction(() =>
            body().pipe(
              Effect.tap(() =>
                Effect.suspend(() =>
                  failCommit
                    ? Effect.fail(sqliteFailure("commit failed"))
                    : Effect.void
                )
              )
            )
          ),
      }
      const service = yield* AgentCatalog.pipe(
        Effect.provide(agentCatalogApplication(new SqliteAgentCatalog(failing)))
      )
      failCommit = true
      expect(
        yield* service.update({ ...details(), name: "New" }).pipe(Effect.result)
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "AgentStorageError" },
      })
      expect(yield* f.catalog.requireActive(id(1))).toMatchObject({
        name: "Research",
        revision: 0,
      })
    })
)
it.effect(
  "corrupt profile and creation records remain defects instead of typed storage failures",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.catalog.create(details())
      corrupt(f.db, "UPDATE agent_catalog SET revision=-1 WHERE id=?", id(1))
      const stored = yield* f.catalog.list().pipe(Effect.exit)
      expect(Exit.isFailure(stored) && Cause.hasDies(stored.cause)).toBe(true)
      expect(Exit.isFailure(stored) && Cause.hasFails(stored.cause)).toBe(false)
      corrupt(
        f.db,
        "UPDATE agent_catalog SET revision=0,creation=x'ff' WHERE id=?",
        id(1)
      )
      const replay = yield* f.catalog.create(details()).pipe(Effect.exit)
      expect(Exit.isFailure(replay) && Cause.hasDies(replay.cause)).toBe(true)
    })
)
it.effect(
  "catalog reopening preserves profile dates and creation identity",
  () =>
    Effect.gen(function* () {
      const db = database()
      db.run(
        "INSERT INTO agent_catalog(id,name,instructions,status,createdAt,updatedAt,creation) VALUES (?,?,?,?,?,?,?)",
        id(1),
        "Research",
        "Synthetic",
        "active",
        "original date",
        "original date",
        JSON.stringify(details())
      )
      yield* migrateSqlite(db)
      const f = yield* fixture(db)
      expect(yield* f.catalog.create(details())).toMatchObject({
        revision: 0,
        createdAt: "original date",
      })
      yield* f.catalog.archive(id(1), true)
      yield* f.catalog.archive(id(1), false)
      const reopened = yield* AgentCatalog.pipe(
        Effect.provide(agentCatalogApplication(new SqliteAgentCatalog(db)))
      )
      expect(yield* reopened.requireActive(id(1))).toMatchObject({
        revision: 2,
        createdAt: "original date",
      })
    })
)
it.effect(
  "configuration projects sticky revocation from a delayed archive without undoing a newer restore",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(),
        events: string[] = [],
        projections: TerminalAuthorityProjection[] = []
      yield* f.configuration.configure("owner", profile(3, "active"))
      yield* configureAgent(f.configured, host(events, projections))(
        "owner",
        profile(2, "archived")
      )
      expect(projections).toEqual([
        { revision: 3, active: true, revokeThrough: 2 },
      ])
      expect(events).toEqual(["terminal", "extract", "apps", "routines"])
      expect(yield* f.configuration.read()).toMatchObject({
        revision: 3,
        status: "active",
      })
    })
)
it.effect(
  "configuration re-reads newer authority after terminal acknowledgment before starting work",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(),
        events: string[] = [],
        projections: TerminalAuthorityProjection[] = []
      const h: AgentConfigurationHost<AgentConflict | AgentStorageError> = host(
        events,
        projections
      )
      h.syncTerminal = (value) =>
        Effect.gen(function* () {
          projections.push(value)
          yield* f.configuration.configure("owner", profile(2, "archived"))
        })
      yield* configureAgent(f.configured, h)("owner", profile(1))
      expect(projections).toEqual([
        { revision: 1, active: true, revokeThrough: undefined },
      ])
      expect(events).toEqual(["browser"])
    })
)
it.effect(
  "archive publication and native profile acknowledgment survive interruption in caller Context",
  () =>
    Effect.gen(function* () {
      class Request extends Context.Service<Request, string>()(
        "test/AgentArchiveRequest"
      ) {}
      const f = yield* fixture(),
        entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      yield* f.catalog.create(details())
      let projected: AgentProfile | undefined
      const command = archiveAgent(f.catalog, (_owner, value) =>
        Effect.gen(function* () {
          expect(yield* Request).toBe("this request")
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
          projected = value
        })
      )
      const pending = yield* command("owner", id(1), true).pipe(
        Effect.provideService(Request, "this request"),
        Effect.forkChild
      )
      yield* Deferred.await(entered)
      expect(yield* f.ledger.read(id(1))).toMatchObject({
        status: "archived",
        revision: 1,
      })
      const stopping = yield* Fiber.interrupt(pending).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(stopping)
      expect(projected).toMatchObject({ status: "archived", revision: 1 })
      const exit = yield* Fiber.await(pending)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    })
)
it.effect(
  "failed profile projection retains committed catalog state and expected HTTP behavior",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.catalog.create(details())
      const command = archiveAgent(f.catalog, () =>
        Effect.fail(
          new AgentSynchronizationError({ operation: "project profile" })
        )
      )
      const response = yield* agentCatalogRequest(
        f.catalog,
        command,
        "bots/archive",
        "owner",
        { id: id(1), archived: true }
      )
      expect(response.status).toBe(409)
      expect(yield* f.ledger.read(id(1))).toMatchObject({
        status: "archived",
        revision: 1,
      })
      const invalid = yield* agentCatalogRequest(
        f.catalog,
        command,
        "bots/create",
        "owner",
        { id: "../bad", name: "Bad" }
      )
      expect(invalid.status).toBe(400)
      expect(yield* Effect.promise(() => invalid.text())).not.toContain(
        "../bad"
      )
    })
)
it.effect(
  "native terminal projection releases its response body before returning acknowledgment",
  () =>
    Effect.gen(function* () {
      const events: string[] = []
      let received: unknown
      yield* synchronizeTerminalAuthority(
        {
          fetch: async (request) => {
            received = await request.json()
            return new Response(
              new ReadableStream({
                cancel() {
                  events.push("body.closed")
                },
              })
            )
          },
        },
        "actor",
        { revision: 3, active: true, revokeThrough: 2 }
      )
      expect(received).toEqual({ revision: 3, active: true, revokeThrough: 2 })
      expect(events).toEqual(["body.closed"])
      const failed = yield* synchronizeTerminalAuthority(
        { fetch: async () => new Response(null, { status: 503 }) },
        "actor",
        { revision: 3, active: false }
      ).pipe(Effect.result)
      expect(failed).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "AgentSynchronizationError" },
      })
      expect(() =>
        configurationInput("owner", { ...profile(), revision: -1 })
      ).toThrow("Invalid bot profile")
    })
)
it.effect(
  "native acknowledgments retain codec defects and synchronous callback defects",
  () =>
    Effect.gen(function* () {
      const codec = yield* agentNativeOperation("project", () =>
        Promise.reject(new SyntaxError("private codec detail"))
      ).pipe(Effect.exit)
      expect(Exit.isFailure(codec) && Cause.hasDies(codec.cause)).toBe(true)
      const synchronous = yield* agentNativeOperation("project", () => {
        throw new Error("private programming detail")
      }).pipe(Effect.exit)
      expect(
        Exit.isFailure(synchronous) && Cause.hasDies(synchronous.cause)
      ).toBe(true)
    })
)
it.effect(
  "status deadline bounds active reads to four and still reports queued archived profiles",
  () =>
    Effect.gen(function* () {
      const profiles = Array.from({ length: 8 }, (_, index) => ({
        ...profile(),
        id: id(index + 1),
      }))
      profiles.push({ ...profile(0, "archived"), id: id(9) })
      const entered = yield* Deferred.make<void>()
      let calls = 0,
        stopped = 0
      const pending = yield* agentStatuses(profiles, () =>
        Effect.gen(function* () {
          calls++
          if (calls === 4) yield* Deferred.succeed(entered, undefined)
          return yield* Effect.never
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              stopped++
            })
          )
        )
      ).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* TestClock.adjust("5 seconds")
      const result = yield* Fiber.join(pending)
      expect(calls).toBe(4)
      expect(stopped).toBe(4)
      expect(
        result.statuses
          .slice(0, 8)
          .every((value) => value.state === "unavailable")
      ).toBe(true)
      expect(result.statuses[8]).toEqual({
        agentId: id(9),
        state: "archived",
        turnId: null,
      })
    })
)
it.effect(
  "status RPC maps transport failures but leaves malformed DTOs and local defects distinguishable",
  () =>
    Effect.gen(function* () {
      const owned: Promise<void>[] = []
      const reader = agentRuntimeReader(
        async () => {
          throw new Error("private RPC detail")
        },
        (work) => {
          owned.push(work)
        }
      )
      expect(yield* reader(profile()).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "AgentRuntimeUnavailable" },
      })
      yield* Effect.promise(() => Promise.all(owned))
      expect(owned).toHaveLength(1)
      const malformedReader = agentRuntimeReader(
        async () => ({ state: "ready", turnId: 3 }),
        (work) => {
          owned.push(work)
          void work.catch(() => {})
        }
      )
      const exit = yield* malformedReader(profile()).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      const defect = yield* agentStatuses([profile()], () =>
        Effect.die(new Error("local bug"))
      ).pipe(Effect.exit)
      expect(Exit.isFailure(defect) && Cause.hasDies(defect.cause)).toBe(true)
    })
)
it("actor disposal joins terminal response cleanup before releasing its Layer", async () => {
  const events: string[] = []
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((resolve) => {
      entered = resolve
    }),
    held = new Promise<void>((resolve) => {
      release = resolve
    })
  const runtime = ManagedRuntime.make(
    Layer.effectDiscard(
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          events.push("layer.closed")
        })
      )
    )
  )
  try {
    const pending = runtime.runPromiseExit(
      synchronizeTerminalAuthority(
        {
          fetch: async () =>
            new Response(
              new ReadableStream({
                async cancel() {
                  entered()
                  await held
                  events.push("body.closed")
                },
              })
            ),
        },
        "actor",
        { revision: 1, active: true }
      )
    )
    await started
    const closing = runtime.dispose()
    expect(events).toEqual([])
    release()
    await closing
    await pending
    expect(events).toEqual(["body.closed", "layer.closed"])
  } finally {
    release()
    await runtime.dispose()
  }
})
