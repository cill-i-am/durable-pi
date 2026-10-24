import { it } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { afterEach, expect, vi } from "vitest"

import { hostedSkillRequests } from "../src/features/skills/hosted-skill-owner"
import {
  hostedSkillMachine,
  type HostedSkillWork,
} from "../src/features/skills/hosted-skill.machine"
import {
  skillViewMachine,
  type SkillViewWork,
} from "../src/features/skills/skill-view.machine"
import {
  makeSkillsOwner,
  skillCommand,
  skillWorkFailures,
  skillVersions,
  skillsRequests,
} from "../src/features/skills/skills-owner"
import {
  skillsMachine,
  type SkillCommand,
  type SkillsWork,
} from "../src/features/skills/skills.machine"
import { readSkillFile } from "../src/features/skills/use-skill-view"
import { nativeOperation } from "../src/shared/interop"
import type { Skill } from "../src/skills/contracts"
import type { HostedSkill } from "../src/skills/source"

const id = "00000000-0000-0000-0000-000000000001"
const skill: Skill = {
  id,
  name: "Original",
  body: "Original body",
  revision: 1,
  stateRevision: 1,
  createdAt: "2026-10-23T00:00:00.000Z",
  archived: false,
}
const save: SkillCommand = {
  kind: "save",
  input: { id, expectedRevision: 1, name: "Saved", body: "New body" },
}
const defaults: SkillsWork = {
  read: () =>
    Effect.succeed({
      library: [skill],
      selection: { revision: 1, skills: [] },
    }),
  command: () => Effect.succeed(skill),
}
const viewDefaults: SkillViewWork = {
  file: readSkillFile,
  versions: () => Effect.succeed([skill]),
  draft: () => Effect.void,
}
const hosted: HostedSkill = {
  name: "Instructions",
  description: "Description",
  app: { id: "app", slug: "app", name: "App" },
  deployment: "main",
  revision: "pinned",
}
const tool = {
  name: `mcp_${"a".repeat(40)}`,
  connectionId: `mcp-${"a".repeat(32)}`,
  connectionRevision: 1,
  connectionName: "Executor",
  remoteName: "skills",
  description: "",
  parameters: {},
}
const draft = { ...save.input }
const hostedDefaults: HostedSkillWork = {
  providers: () => Effect.succeed([tool]),
  browse: () => Effect.succeed([hosted]),
  read: () => Effect.succeed(draft),
}
afterEach(() => vi.unstubAllGlobals())

it.effect(
  "refresh and duplicate commands never replace the accepted immutable CAS input",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      const calls: SkillCommand[] = []
      let reads = 0
      const actor = yield* makeSkillsOwner(undefined, {
        ...defaults,
        read: () =>
          Effect.sync(() => {
            reads++
            return { library: [skill], selection: { revision: 1, skills: [] } }
          }),
        command: (input) =>
          Effect.sync(() => {
            calls.push(input)
          }).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Deferred.await(release)),
            Effect.as({
              ...skill,
              ...save.input,
              revision: 2,
              stateRevision: 2,
            })
          ),
      })
      const first = yield* skillCommand(actor, save).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* send(actor, { type: "REFRESH" })
      expect(
        yield* skillCommand(actor, {
          ...save,
          input: { ...save.input, body: "Different" },
        })
      ).toBeUndefined()
      expect(calls).toEqual([save])
      expect(reads).toBe(0)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      yield* waitFor(actor, (snapshot) => snapshot.context.ready)
      expect(reads).toBe(1)
      expect(actor.getSnapshot().context.library[0]?.revision).toBe(2)
    }).pipe(Effect.scoped)
)

it.effect(
  "reload observes without repeating failed writes; explicit retry keeps exact input",
  () =>
    Effect.gen(function* () {
      const calls: SkillCommand[] = []
      const actor = yield* makeSkillsOwner(undefined, {
        ...defaults,
        command: (input) =>
          Effect.suspend(() => {
            calls.push(input)
            return calls.length === 1
              ? Effect.fail(new Error("response lost"))
              : Effect.succeed(skill)
          }),
      })
      expect(yield* skillCommand(actor, save)).toBeUndefined()
      expect(actor.getSnapshot().context.failed).toEqual(save)
      yield* send(actor, { type: "REFRESH" })
      yield* waitFor(actor, (snapshot) => snapshot.context.ready)
      expect(calls).toEqual([save])
      yield* skillCommand(actor, actor.getSnapshot().context.failed!)
      expect(calls).toEqual([save, save])
    }).pipe(Effect.scoped)
)

it.effect(
  "replacing an agent joins the actual held HTTP request and cannot populate the new actor",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        aborted = yield* Deferred.make<void>()
      let release!: (value: Response) => void
      const fetch = vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            release = resolve
            init?.signal?.addEventListener("abort", () =>
              Effect.runSync(Deferred.succeed(aborted, undefined))
            )
            Effect.runSync(Deferred.succeed(entered, undefined))
          })
      )
      vi.stubGlobal("fetch", fetch)
      const scope = yield* Scope.make()
      const old = yield* makeSkillsOwner("old", skillsRequests("old")).pipe(
        Scope.provide(scope)
      )
      yield* send(old, {
        type: "COMMAND",
        id: "old",
        command: { kind: "select", input: { expectedRevision: 1, skills: [] } },
      })
      yield* Deferred.await(entered)
      let closed = false
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            closed = true
          })
        ),
        Effect.forkChild
      )
      yield* Deferred.await(aborted)
      expect(closed).toBe(false)
      const current = yield* makeSkillsOwner("new", {
        ...defaults,
        read: () =>
          Effect.succeed({
            library: [],
            selection: { revision: 7, skills: [] },
          }),
      })
      yield* send(current, { type: "REFRESH" })
      yield* waitFor(current, (snapshot) => snapshot.context.ready)
      release(Response.json({ revision: 2, skills: [] }))
      yield* Fiber.join(closing)
      expect(current.getSnapshot().context.selection.revision).toBe(7)
      expect(fetch.mock.calls[0]?.[0]).toContain("agent=old")
    }).pipe(Effect.scoped)
)

it.effect(
  "actual HTTP command preserves the captured save payload and rejects another skill identity",
  () =>
    Effect.gen(function* () {
      const fetch = vi.fn(async () =>
        Response.json({ ...skill, id: "00000000-0000-0000-0000-000000000002" })
      )
      vi.stubGlobal("fetch", fetch)
      const exit = yield* Effect.exit(skillsRequests(undefined).command(save))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(
        JSON.parse(
          (fetch.mock.calls as unknown as [string, RequestInit][])[0]![1]
            .body as string
        )
      ).toEqual(save.input)
    }).pipe(Effect.scoped)
)

it.effect(
  "cleanup retains checked, defect and native interruption reasons after actual abort",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        aborted = yield* Deferred.make<void>()
      let reject!: (value: unknown) => void
      const scope = yield* Scope.make()
      const actor = yield* makeSkillsOwner(undefined, {
        ...defaults,
        read: () =>
          nativeOperation(
            (signal) =>
              new Promise((_, fail) => {
                reject = fail
                signal.addEventListener("abort", () =>
                  Effect.runSync(Deferred.succeed(aborted, undefined))
                )
                Effect.runSync(Deferred.succeed(entered, undefined))
              }),
            (cause) => cause
          ),
      }).pipe(Scope.provide(scope))
      yield* send(actor, { type: "REFRESH" })
      yield* Deferred.await(entered)
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.exit,
        Effect.forkChild
      )
      yield* Deferred.await(aborted)
      reject(
        Cause.fromReasons([
          Cause.makeFailReason(new Error("checked-native")),
          Cause.makeDieReason(new Error("native-defect")),
          Cause.makeInterruptReason(81234),
        ])
      )
      const exit = yield* Fiber.join(closing)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(
          exit.cause.reasons.some(
            (reason) => reason._tag === "Interrupt" && reason.fiberId === 81234
          )
        ).toBe(true)
        expect(
          JSON.stringify(
            exit.cause.reasons.map((reason) =>
              reason._tag === "Die" ? String(reason.defect) : ""
            )
          )
        ).toContain("checked-native")
        expect(
          JSON.stringify(
            exit.cause.reasons.map((reason) =>
              reason._tag === "Die" ? String(reason.defect) : ""
            )
          )
        ).toContain("native-defect")
      }
    }).pipe(Effect.scoped)
)

it.effect(
  "an older save acknowledgement cannot close a newly opened editor",
  () =>
    Effect.gen(function* () {
      const actor = yield* createEffectActor(skillViewMachine(viewDefaults))
      yield* send(actor, { type: "EDIT", draft })
      yield* waitFor(actor, (snapshot) => snapshot.matches("editing"))
      const generation = actor.getSnapshot().context.generation
      yield* send(actor, { type: "CANCEL" })
      yield* send(actor, {
        type: "EDIT",
        draft: { ...draft, body: "Replacement" },
      })
      yield* waitFor(
        actor,
        (snapshot) => snapshot.context.generation === generation + 2
      )
      const processed = yield* Deferred.make<unknown>()
      const subscription = actor.inspect((event) => {
        if (event.type === "@xstate.transition" && event.event.type === "SAVED")
          Effect.runSync(Deferred.succeed(processed, event.snapshot))
      })
      yield* send(actor, { type: "SAVED", generation })
      const saved = yield* Deferred.await(processed)
      subscription.unsubscribe()
      expect(saved).toMatchObject({ value: "editing" })
      yield* send(actor, { type: "LEAVE" })
      expect(actor.getSnapshot().matches("editing")).toBe(true)
      yield* send(actor, {
        type: "SAVED",
        generation: actor.getSnapshot().context.generation,
      })
      yield* waitFor(actor, (snapshot) => snapshot.matches("library"))
      expect(actor.getSnapshot().matches("library")).toBe(true)
    }).pipe(Effect.scoped)
)

it.effect("oversize local files are rejected before reading any bytes", () =>
  Effect.gen(function* () {
    let reads = 0
    const actor = yield* createEffectActor(
      skillViewMachine({
        ...viewDefaults,
        file: () =>
          Effect.sync(() => {
            reads++
            return draft
          }),
      })
    )
    yield* send(actor, {
      type: "FILE",
      id,
      file: new File(["a".repeat(64001)], "large.md"),
    })
    yield* waitFor(actor, (snapshot) => snapshot.context.error.length > 0)
    expect(reads).toBe(0)
    expect(actor.getSnapshot().context.error).toContain("64 KB")
  }).pipe(Effect.scoped)
)

it.effect(
  "a cancelled unabortable file read is joined and cannot replace the editor",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      let release!: (body: string) => void
      const file = new File(["old"], "old.md")
      vi.spyOn(file, "text").mockImplementation(() => {
        Effect.runSync(Deferred.succeed(entered, undefined))
        return new Promise((resolve) => {
          release = resolve
        })
      })
      const drafts: string[] = [],
        scope = yield* Scope.make()
      const actor = yield* createEffectActor(
        skillViewMachine({
          ...viewDefaults,
          draft: (value) =>
            Effect.sync(() => {
              drafts.push(value.body)
            }),
        })
      ).pipe(Scope.provide(scope))
      yield* send(actor, { type: "FILE", id, file })
      yield* Deferred.await(entered)
      yield* send(actor, { type: "CANCEL" })
      yield* send(actor, {
        type: "EDIT",
        draft: { ...draft, body: "New editor" },
      })
      let closed = false
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            closed = true
          })
        ),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      expect(closed).toBe(false)
      release("Old imported body")
      yield* Fiber.join(closing)
      expect(drafts).toEqual(["New editor"])
    }).pipe(Effect.scoped)
)

it.effect(
  "file decoding enforces the character budget and preserves Markdown contents",
  () =>
    Effect.gen(function* () {
      const decoded = yield* readSkillFile(
        new File(["# Kept\n\ntext"], "Name.md"),
        id
      )
      expect(decoded).toEqual({
        id,
        name: "Name",
        body: "# Kept\n\ntext",
        expectedRevision: 0,
      })
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            readSkillFile(new File(["a".repeat(16001)], "too-long.md"), id)
          )
        )
      ).toBe(true)
    }).pipe(Effect.scoped)
)

it.effect(
  "late history completion cannot reopen a closed or replaced view",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>()
      const actor = yield* createEffectActor(
        skillViewMachine({
          ...viewDefaults,
          versions: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as([skill])
            ),
        })
      )
      yield* send(actor, { type: "HISTORY", skill })
      yield* Deferred.await(entered)
      yield* send(actor, { type: "LEAVE" })
      yield* send(actor, { type: "EDIT", draft })
      yield* waitFor(actor, (snapshot) => snapshot.matches("editing"))
      yield* Deferred.succeed(release, undefined)
      yield* Effect.yieldNow
      expect(actor.getSnapshot().matches("editing")).toBe(true)
      expect(actor.getSnapshot().context.versions).toEqual([])
    }).pipe(Effect.scoped)
)

it.effect(
  "hosted import captures the catalog revision and mints no save before preview confirmation",
  () =>
    Effect.gen(function* () {
      const calls: unknown[] = [],
        previews: unknown[] = []
      const actor = yield* createEffectActor(
        hostedSkillMachine({
          ...hostedDefaults,
          read: (input) =>
            Effect.sync(() => {
              calls.push(input)
              return draft
            }),
        })
      )
      const previewed = yield* Deferred.make<void>()
      actor.on("preview", (event) => {
        previews.push(event.draft)
        Effect.runSync(Deferred.succeed(previewed, undefined))
      })
      yield* waitFor(actor, (snapshot) => snapshot.matches("ready"))
      yield* send(actor, { type: "BROWSE", app: "app" })
      yield* waitFor(actor, (snapshot) => snapshot.context.catalog !== null)
      yield* send(actor, { type: "READ", id, skill: hosted })
      yield* waitFor(actor, (snapshot) => snapshot.matches("previewed"))
      expect(calls).toEqual([{ id, toolName: tool.name, skill: hosted }])
      yield* Deferred.await(previewed)
      expect(previews).toEqual([draft])
    }).pipe(Effect.scoped)
)

it.effect(
  "closing hosted import aborts and joins its held read with no late preview",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        aborted = yield* Deferred.make<void>()
      let release!: (value: typeof draft) => void
      const previews: unknown[] = [],
        scope = yield* Scope.make()
      const observe = yield* skillWorkFailures.pipe(Scope.provide(scope))
      const actor = yield* createEffectActor(
        hostedSkillMachine({
          ...hostedDefaults,
          read: () =>
            observe(
              nativeOperation(
                (signal) =>
                  new Promise((resolve) => {
                    release = resolve
                    signal.addEventListener("abort", () =>
                      Effect.runSync(Deferred.succeed(aborted, undefined))
                    )
                    Effect.runSync(Deferred.succeed(entered, undefined))
                  }),
                (cause) => cause
              )
            ),
        })
      ).pipe(Scope.provide(scope))
      actor.on("preview", (event) => previews.push(event.draft))
      yield* waitFor(actor, (snapshot) => snapshot.matches("ready"))
      yield* send(actor, { type: "BROWSE", app: "app" })
      yield* waitFor(actor, (snapshot) => snapshot.context.catalog !== null)
      yield* send(actor, { type: "READ", id, skill: hosted })
      yield* Deferred.await(entered)
      yield* send(actor, { type: "CANCEL" })
      yield* Deferred.await(aborted)
      let closed = false
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            closed = true
          })
        ),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      expect(closed).toBe(false)
      release(draft)
      yield* Fiber.join(closing)
      expect(previews).toEqual([])
    }).pipe(Effect.scoped)
)

it.effect(
  "actual hosted HTTP rejects changed pinned identity and preserves source metadata",
  () =>
    Effect.gen(function* () {
      const source = {
        ...hosted,
        connectionId: tool.connectionId,
        connectionName: tool.connectionName,
        toolName: tool.name,
        files: ["SKILL.md", "reference.md"],
      }
      const fetch = vi.fn(async () =>
        Response.json({ name: "Instructions", body: "Body", source })
      )
      vi.stubGlobal("fetch", fetch)
      const input = { id, toolName: tool.name, skill: hosted }
      expect((yield* hostedSkillRequests.read(input)).source).toEqual(source)
      expect(
        JSON.parse(
          (fetch.mock.calls as unknown as [string, RequestInit][])[0]![1]
            .body as string
        )
      ).toEqual({ toolName: tool.name, skill: hosted })
      fetch.mockImplementation(async () =>
        Response.json({
          name: "Instructions",
          body: "Body",
          source: { ...source, revision: "changed" },
        })
      )
      expect(
        Exit.isFailure(yield* Effect.exit(hostedSkillRequests.read(input)))
      ).toBe(true)
    }).pipe(Effect.scoped)
)

it.effect("invalid command payload is rejected before native work", () =>
  Effect.gen(function* () {
    let calls = 0
    const actor = yield* createEffectActor(
      skillsMachine({
        ...defaults,
        command: () =>
          Effect.sync(() => {
            calls++
            return skill
          }),
      }),
      { input: undefined }
    )
    yield* Effect.exit(
      send(actor, {
        type: "COMMAND",
        id: "invalid",
        command: {
          kind: "save",
          input: { ...save.input, expectedRevision: -1 },
        },
      })
    )
    yield* send(actor, { type: "REFRESH" })
    yield* waitFor(actor, (snapshot) => snapshot.context.ready)
    expect(actor.getSnapshot().matches({ command: "ready" })).toBe(true)
    expect(calls).toBe(0)
  }).pipe(Effect.scoped)
)

it.effect("actual history HTTP cannot attach another skill's revisions", () =>
  Effect.gen(function* () {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          versions: [{ ...skill, id: "00000000-0000-0000-0000-000000000002" }],
        })
      )
    )
    expect(Exit.isFailure(yield* Effect.exit(skillVersions(id)))).toBe(true)
  }).pipe(Effect.scoped)
)

it.effect(
  "owner disposal retains a direct capability's annotated failure and interruption",
  () =>
    Effect.gen(function* () {
      class Origin extends Context.Service<Origin, string>()(
        "SkillsDirectOrigin"
      ) {}
      const annotations = Context.make(Origin, "direct-capability")
      const checked =
        Cause.makeFailReason("direct failed").annotate(annotations)
      const failure = Cause.fromReasons([
        checked,
        Cause.makeInterruptReason(81236).annotate(annotations),
      ])
      const scope = yield* Scope.make()
      const actor = yield* makeSkillsOwner(undefined, {
        ...defaults,
        command: () => Effect.failCause(failure),
      }).pipe(Scope.provide(scope))
      expect(yield* skillCommand(actor, save)).toBeUndefined()
      const exit = yield* Effect.exit(Scope.close(scope, Exit.void))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(
          exit.cause.reasons.some(
            (reason) =>
              reason._tag === "Interrupt" &&
              reason.fiberId === 81236 &&
              reason.annotations.get(Origin.key) === "direct-capability"
          )
        ).toBe(true)
        expect(
          exit.cause.reasons.some((reason) => {
            if (reason._tag !== "Die") return false
            const retained = reason.defect
            return (
              retained !== null &&
              typeof retained === "object" &&
              "_tag" in retained &&
              retained._tag === "Fail" &&
              "error" in retained &&
              retained.error === "direct failed" &&
              "annotations" in retained &&
              retained.annotations instanceof Map &&
              retained.annotations.get(Origin.key) === "direct-capability"
            )
          })
        ).toBe(true)
      }
    }).pipe(Effect.scoped)
)

it("retains annotated Fail plus native Interrupt after joining a rejected held Skills fetch", async () => {
  let reject!: (e: unknown) => void
  let signal: AbortSignal | undefined
  const held = new Promise<never>((_, no) => {
    reject = no
  })
  vi.stubGlobal(
    "fetch",
    vi.fn((_path: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return held
    })
  )
  class NativeRequest extends Context.Service<NativeRequest, string>()(
    "F12NativeRequest"
  ) {}
  const native = Cause.fromReasons([
    Cause.makeFailReason("native failed"),
    Cause.makeInterruptReason(81235).annotate(
      Context.make(NativeRequest, "f12")
    ),
  ])
  const scope = Effect.runSync(Scope.make())
  const actor = Effect.runSync(
    makeSkillsOwner("a", skillsRequests("a")).pipe(
      Effect.provideService(Scope.Scope, scope)
    )
  )
  await actor.send({
    type: "COMMAND",
    id: "one",
    command: { kind: "select", input: { expectedRevision: 1, skills: [] } },
  })
  await vi.waitFor(() => expect(signal).toBeDefined())
  let done = false
  const closing = Effect.runPromiseExit(Scope.close(scope, Exit.void)).then(
    (v) => {
      done = true
      return v
    }
  )
  await vi.waitFor(() => expect(signal?.aborted).toBe(true))
  expect(done).toBe(false)
  reject(native)
  const result = await closing
  expect(Exit.isFailure(result)).toBe(true)
  if (Exit.isFailure(result)) {
    expect(
      result.cause.reasons.some(
        (r) =>
          r._tag === "Interrupt" &&
          r.fiberId === 81235 &&
          r.annotations.get(NativeRequest.key) === "f12"
      )
    ).toBe(true)
    expect(
      result.cause.reasons.some(
        (r) =>
          r._tag === "Die" &&
          r.defect &&
          typeof r.defect === "object" &&
          "error" in r.defect &&
          r.defect.error === "native failed"
      )
    ).toBe(true)
  }
})
it("joins the actual File.text read and preserves annotated native Fail plus Interrupt", async () => {
  let reject!: (e: unknown) => void
  const held = new Promise<never>((_, no) => {
    reject = no
  })
  const file = new File(["# instructions"], "instructions.md"),
    read = vi.fn(() => held)
  Object.defineProperty(file, "text", { value: read })
  class NativeFile extends Context.Service<NativeFile, string>()(
    "F12NativeFile"
  ) {}
  const native = Cause.fromReasons([
    Cause.makeFailReason("file read failed"),
    Cause.makeInterruptReason(81236).annotate(Context.make(NativeFile, "file")),
  ])
  const scope = Effect.runSync(Scope.make())
  const actor = Effect.runSync(
    Effect.gen(function* () {
      const observe = yield* skillWorkFailures
      return yield* createEffectActor(
        skillViewMachine({
          file: (file, id) => observe(readSkillFile(file, id)),
          versions: () => Effect.succeed([]),
          draft: () => Effect.void,
        })
      )
    }).pipe(Effect.provideService(Scope.Scope, scope))
  )
  await actor.send({
    type: "FILE",
    file,
    id: "11111111-1111-4111-8111-111111111111",
  })
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  let done = false
  const closing = Effect.runPromiseExit(Scope.close(scope, Exit.void)).then(
    (v) => {
      done = true
      return v
    }
  )
  await new Promise((r) => setTimeout(r, 20))
  expect(done).toBe(false)
  reject(native)
  const result = await closing
  expect(Exit.isFailure(result)).toBe(true)
  if (Exit.isFailure(result)) {
    expect(
      result.cause.reasons.some(
        (r) =>
          r._tag === "Interrupt" &&
          r.fiberId === 81236 &&
          r.annotations.get(NativeFile.key) === "file"
      )
    ).toBe(true)
    expect(
      result.cause.reasons.some(
        (r) =>
          r._tag === "Die" &&
          r.defect &&
          typeof r.defect === "object" &&
          "error" in r.defect &&
          r.defect.error === "file read failed"
      )
    ).toBe(true)
  }
})

it.each(["refresh", "command"] as const)(
  "retains one actual read batch across repeated %s events and joins before its successor",
  async (kind) => {
    const requests: {
      path: string
      signal: AbortSignal
      release: (response: Response) => void
    }[] = []
    const fetch = vi.fn((path: string, init?: RequestInit) =>
      init?.body
        ? Promise.resolve(Response.json({ revision: 7, skills: [] }))
        : new Promise<Response>((release) => {
            requests.push({ path, signal: init!.signal!, release })
          })
    )
    vi.stubGlobal("fetch", fetch)
    const scope = Effect.runSync(Scope.make())
    const actor = Effect.runSync(
      makeSkillsOwner("agent", skillsRequests("agent")).pipe(
        Scope.provide(scope)
      )
    )
    const release = (batch: typeof requests, revision: number) => {
      for (const request of batch)
        request.release(
          Response.json(
            request.path.includes("skill-selection")
              ? { revision, skills: [] }
              : { skills: [] }
          )
        )
    }
    try {
      await actor.send({ type: "REFRESH" })
      await vi.waitFor(() => expect(requests).toHaveLength(2))
      if (kind === "command") {
        await Effect.runPromise(
          skillCommand(actor, {
            kind: "select",
            input: { expectedRevision: 1, skills: [] },
          })
        )
        expect(actor.getSnapshot().context.selection.revision).toBe(7)
      }
      for (let count = 0; count < 8; count++)
        await actor.send({ type: "REFRESH" })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(requests).toHaveLength(2)
      expect(requests.every((request) => !request.signal.aborted)).toBe(true)
      release(requests.slice(0, 2), 2)
      await vi.waitFor(() => expect(requests).toHaveLength(4))
      expect(actor.getSnapshot().context.selection.revision).toBe(
        kind === "command" ? 7 : 0
      )
      release(requests.slice(2), 8)
      await vi.waitFor(() =>
        expect(actor.getSnapshot().context.selection.revision).toBe(8)
      )
      expect(actor.getSnapshot().matches({ resource: "idle" })).toBe(true)
      expect(requests).toHaveLength(4)
      expect(fetch.mock.calls.filter(([, init]) => !!init?.body)).toHaveLength(
        kind === "command" ? 1 : 0
      )
    } finally {
      const closing = Effect.runPromiseExit(Scope.close(scope, Exit.void))
      release(requests, 8)
      await closing
    }
  }
)

it.effect(
  "library and agent machines reject commands belonging to the other view",
  () =>
    Effect.gen(function* () {
      const calls: SkillCommand[] = []
      const work = {
        ...defaults,
        command: (command: SkillCommand) =>
          Effect.sync(() => {
            calls.push(command)
            return skill
          }),
      }
      const library = yield* makeSkillsOwner(undefined, work)
      const agent = yield* makeSkillsOwner("agent", work)
      expect(yield* skillCommand(agent, save)).toBeUndefined()
      expect(
        yield* skillCommand(library, {
          kind: "select",
          input: { expectedRevision: 0, skills: [] },
        })
      ).toBeUndefined()
      expect(calls).toEqual([])
      yield* skillCommand(library, save)
      expect(calls).toEqual([save])
    }).pipe(Effect.scoped)
)

it.effect(
  "library reads omit agent selection and the HTTP boundary rejects cross-view writes",
  () =>
    Effect.gen(function* () {
      const fetch = vi.fn(async (_path: string) =>
        Response.json({ skills: [skill] })
      )
      vi.stubGlobal("fetch", fetch)
      const library = skillsRequests(undefined)
      expect((yield* library.read()).selection).toEqual({
        revision: 0,
        skills: [],
      })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(String(fetch.mock.calls[0]?.[0])).not.toContain("skill-selection")
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            library.command({
              kind: "select",
              input: { expectedRevision: 0, skills: [] },
            })
          )
        )
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* Effect.exit(skillsRequests("agent").command(save))
        )
      ).toBe(true)
      expect(fetch).toHaveBeenCalledTimes(1)
    }).pipe(Effect.scoped)
)
