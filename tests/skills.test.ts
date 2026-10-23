import { Clock, Cause, Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { skillsRequest } from "../src/skills/adapters/http"
import { SkillStore } from "../src/skills/adapters/sqlite"
import {
  SkillConflict,
  SkillStorageError,
  SaveSkill,
  SelectSkills,
  skillContext,
} from "../src/skills/contracts"
import { selectBotSkills } from "../src/skills/selection"
import { makeSkills } from "../src/skills/service"
import { migrateSqlite } from "../src/storage/migrations"
import { database, corrupt } from "./database"

const make = () => new SkillStore(database())
const command = () => ({
  id: crypto.randomUUID(),
  expectedRevision: 0,
  name: "Clear writing",
  body: "Lead with the result. Keep paragraphs short.",
})

describe("versioned owner skills", () => {
  it("guards the selection write inside its synchronous Effect operation", async () => {
    const store = make(),
      document = Effect.runSync(store.save(command()))
    const result = await Effect.runPromise(
      makeSkills(store)
        .select(0, [document], () => Effect.sync(() => false))
        .pipe(Effect.result)
    )
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SkillConflict" },
    })
    expect(Effect.runSync(store.selection())).toEqual({
      revision: 0,
      skills: [],
    })
  })
  it("rolls back the skill version when updating its head fails", () => {
    const db = database(),
      store = new SkillStore(db),
      input = command()
    db.run(
      "CREATE TRIGGER fail_skill_head BEFORE INSERT ON workspace_skills BEGIN SELECT RAISE(ABORT,'disk failure'); END"
    )
    const exit = Effect.runSyncExit(makeSkills(store).save(input))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit))
      expect(Cause.squash(exit.cause)).toBeInstanceOf(SkillStorageError)
    expect(Effect.runSync(store.versions(input.id))).toEqual([])
    expect(Effect.runSync(store.list())).toEqual([])
    db.run("DROP TRIGGER fail_skill_head")
    expect(Effect.runSync(makeSkills(store).save(input)).revision).toBe(1)
    expect(Effect.runSync(store.versions(input.id))).toHaveLength(1)
  })
  it("preserves malformed historical source metadata as a defect", () => {
    const db = database(),
      store = new SkillStore(db),
      input = command()
    Effect.runSync(store.save(input))
    corrupt(
      db,
      "UPDATE workspace_skill_versions SET source='broken' WHERE id=?",
      input.id
    )
    const exit = Effect.runSyncExit(makeSkills(store).versions(input.id))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true)
      expect(Cause.hasFails(exit.cause)).toBe(false)
    }
  })
  it("replays uncertain saves, detects stale edits, and preserves prior revisions", () => {
    const store = make(),
      input = command()
    const one = Effect.runSync(store.save(input))
    expect(Effect.runSync(store.save(input))).toEqual(one)
    const two = Effect.runSync(
      store.save({
        ...input,
        expectedRevision: 1,
        body: "Use plain language.",
      })
    )
    expect(two.revision).toBe(2)
    expect(() =>
      Effect.runSync(
        store.save({ ...input, expectedRevision: 1, body: "Conflicting edit" })
      )
    ).toThrow("changed")
    expect(
      Effect.runSync(store.versions(input.id)).map((value) => value.body)
    ).toEqual([two.body, one.body])
    expect(
      Effect.runSync(store.resolve([{ id: input.id, revision: 1 }]))[0]?.body
    ).toBe(one.body)
    Effect.runSync(store.archive(input.id, 2, true))
    expect(() =>
      Effect.runSync(store.resolve([{ id: input.id, revision: 1 }]))
    ).toThrow("archived")
    expect(() =>
      Effect.runSync(store.save({ ...input, expectedRevision: 2 }))
    ).toThrow("Restore")
    Effect.runSync(store.archive(input.id, 3, false))
    expect(
      Effect.runSync(store.save({ ...input, expectedRevision: 2 })).revision
    ).toBe(3)
  })
  it("replays uncertain archival but never undoes a later restore", () => {
    const store = make(),
      skill = Effect.runSync(store.save(command()))
    const archived = Effect.runSync(
      store.archive(skill.id, skill.stateRevision, true)
    )
    expect(
      Effect.runSync(store.archive(skill.id, skill.stateRevision, true))
    ).toEqual(archived)
    const restored = Effect.runSync(
      store.archive(skill.id, archived.stateRevision, false)
    )
    expect(restored.archived).toBe(false)
    expect(() =>
      Effect.runSync(store.archive(skill.id, skill.stateRevision, true))
    ).toThrow("changed")
    expect(Effect.runSync(store.list())[0]?.archived).toBe(false)
  })
  it("reopens turns with empty skill context without changing their prompts", () => {
    const db = database()
    db.run(
      "INSERT INTO chat_turns(id,text,status,answer,error,created_at,session_id,prompt) VALUES ('old','saved message','running','',NULL,'2026-10-01',NULL,'existing prompt')"
    )
    Effect.runSync(migrateSqlite(db))
    const turns = new ConversationStore(db, { model: "test", thinking: "off" })
    expect(Effect.runSync(turns.get("old"))).toMatchObject({
      text: "saved message",
      prompt: "existing prompt",
      skills: [],
      skill_context: "",
    })
  })
  it("pins shared revisions per bot and retains them after library edits or archival", async () => {
    const owner = make(),
      a = make(),
      b = make(),
      skill = Effect.runSync(owner.save(command()))
    const resolve = async (refs: typeof SelectSkills.Type.skills) => ({
      skills: Effect.runSync(owner.resolve(refs)),
      error: null,
    })
    const select = (
      store: SkillStore,
      revision: number,
      refs: typeof SelectSkills.Type.skills
    ) =>
      Effect.runPromise(
        selectBotSkills(
          makeSkills(store),
          { expectedRevision: revision, skills: refs },
          (references) =>
            Effect.tryPromise({
              try: () => resolve(references),
              catch: () =>
                new SkillConflict({ message: "Could not load these skills." }),
            }),
          () => Effect.sync(() => true)
        )
      )
    const refs = [{ id: skill.id, revision: 1 }]
    await select(a, 0, refs)
    expect(Effect.runSync(b.selection()).skills).toEqual([])
    Effect.runSync(
      owner.save({ ...skill, expectedRevision: 1, body: "Changed" })
    )
    expect(Effect.runSync(a.selection()).skills[0]?.body).toBe(skill.body)
    Effect.runSync(owner.archive(skill.id, 2, true))
    expect(await select(a, 1, refs)).toEqual(Effect.runSync(a.selection()))
    await expect(select(b, 0, refs)).rejects.toBeDefined()
    const next = Effect.runSync(
      owner.save({ ...command(), name: "Second skill" })
    )
    await select(a, 1, [...refs, { id: next.id, revision: 1 }])
    await expect(select(a, 1, [])).rejects.toMatchObject({
      _tag: "SkillConflict",
    })
    await select(a, 2, [])
    expect(Effect.runSync(a.selection()).skills).toEqual([])
  })
  it("rechecks bot archival after remote resolution and rejects duplicates", async () => {
    const store = make(),
      owner = make(),
      skill = Effect.runSync(owner.save(command()))
    let writable = true
    const input = {
      expectedRevision: 0,
      skills: [{ id: skill.id, revision: 1 }],
    }
    await expect(
      Effect.runPromise(
        selectBotSkills(
          makeSkills(store),
          input,
          (references) =>
            Effect.tryPromise({
              try: () =>
                (async (refs) => {
                  writable = false
                  return {
                    skills: Effect.runSync(owner.resolve(refs)),
                    error: null,
                  }
                })(references),
              catch: () =>
                new SkillConflict({ message: "Could not load these skills." }),
            }),
          () => Effect.sync(() => writable)
        )
      )
    ).rejects.toMatchObject({ _tag: "SkillConflict" })
    expect(Effect.runSync(store.selection()).revision).toBe(0)
    await expect(
      Effect.runPromise(
        selectBotSkills(
          makeSkills(store),
          { ...input, skills: [...input.skills, ...input.skills] },
          () => Effect.succeed({ skills: [], error: null }),
          () => Effect.sync(() => true)
        )
      )
    ).rejects.toMatchObject({ _tag: "SkillConflict" })
    expect(() =>
      Schema.decodeUnknownSync(SelectSkills)({
        ...input,
        skills: Array.from({ length: 5 }, () => input.skills[0]),
      })
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(SaveSkill)({
        ...command(),
        body: "x".repeat(16001),
      })
    ).toThrow()
  })
  it("keeps admitted skill context immutable through edits, steering and restart", () => {
    const db = database(),
      owner = make(),
      input = command(),
      skill = Effect.runSync(owner.save(input))
    let turns = new ConversationStore(db, { model: "test", thinking: "off" })
    const submission = {
      operationId: crypto.randomUUID(),
      text: "Draft a note",
    }
    const admitted = Effect.runSync(
      turns.admit(submission, undefined, [skill], undefined, {
        discoveryDeadline: Effect.runSync(Clock.currentTimeMillis) + 60_000,
      })
    ).turn
    expect(admitted.skills).toEqual([
      { id: skill.id, name: skill.name, revision: 1 },
    ])
    expect(admitted.skill_context).toContain(skill.body)
    const changed = Effect.runSync(
      owner.save({
        ...input,
        expectedRevision: 1,
        body: "A new instruction",
      })
    )
    expect(
      Effect.runSync(turns.admit(submission, undefined, [changed])).turn
        .skill_context
    ).toBe(admitted.skill_context)
    turns = new ConversationStore(db, { model: "test", thinking: "off" })
    const steer = Effect.runSync(
      turns.admit(
        {
          operationId: crypto.randomUUID(),
          text: "A shorter note",
          mode: "steer",
        },
        undefined,
        [changed],
        undefined,
        { discoveryDeadline: Effect.runSync(Clock.currentTimeMillis) + 60_000 }
      )
    ).turn
    expect(steer.skills).toEqual(admitted.skills)
    expect(steer.skill_context).toBe("")
    expect(Effect.runSync(turns.recent())[0]?.skill_context).toBe("")
    const prompt = skillContext([skill]) + "\nUser: draft a note"
    Effect.runSync(turns.savePrompt(admitted.id, prompt))
    expect(Effect.runSync(turns.get(admitted.id))?.prompt).toBe(prompt)
    expect(Effect.runSync(turns.get(admitted.id))?.skill_context).toBe("")
    expect(Effect.runSync(turns.recent())[0]?.skills).toEqual(admitted.skills)
  })
  it("returns useful conflicts without leaking storage errors or accepting oversized bodies", async () => {
    const store = make(),
      input = command()
    const request = (value: unknown) =>
      new Request("https://test/api/agent/skills/save", {
        method: "POST",
        body: JSON.stringify(value),
      })
    const saved = await Effect.runPromise(
      skillsRequest(makeSkills(store), request(input), "skills/save")
    )
    expect(saved.status).toBe(200)
    const conflict = await Effect.runPromise(
      skillsRequest(
        makeSkills(store),
        request({ ...input, body: "different" }),
        "skills/save"
      )
    )
    expect(conflict.status).toBe(409)
    expect((await conflict.json<{ error: string }>()).error).toContain(
      "changed"
    )
    const oversized = await Effect.runPromise(
      skillsRequest(
        makeSkills(store),
        request({ ...input, body: "x".repeat(150_000) }),
        "skills/save"
      )
    )
    expect(oversized.status).toBe(409)
  })
})
