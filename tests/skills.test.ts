import { makeSkills } from "../src/skills/service"
import {
  SkillConflict,
  SkillStorageError,
  SaveSkill,
  SelectSkills,
  skillContext,
} from "../src/skills/contracts"
import { describe, expect, it } from "vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import { database } from "./database"
import { SkillStore } from "../src/skills/adapters/sqlite"
import { selectBotSkills } from "../src/skills/selection"
import { skillsRequest } from "../src/skills/adapters/http"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"

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
      document = store.save(command())
    const result = await Effect.runPromise(
      makeSkills(store)
        .select(0, [document], () => false)
        .pipe(Effect.result)
    )
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SkillConflict" },
    })
    expect(store.selection()).toEqual({ revision: 0, skills: [] })
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
    expect(store.versions(input.id)).toEqual([])
    expect(store.list()).toEqual([])
    db.run("DROP TRIGGER fail_skill_head")
    expect(Effect.runSync(makeSkills(store).save(input)).revision).toBe(1)
    expect(store.versions(input.id)).toHaveLength(1)
  })
  it("preserves malformed historical source metadata as a defect", () => {
    const db = database(),
      store = new SkillStore(db),
      input = command()
    store.save(input)
    db.run(
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
    const one = store.save(input)
    expect(store.save(input)).toEqual(one)
    const two = store.save({
      ...input,
      expectedRevision: 1,
      body: "Use plain language.",
    })
    expect(two.revision).toBe(2)
    expect(() =>
      store.save({ ...input, expectedRevision: 1, body: "Conflicting edit" })
    ).toThrow("changed")
    expect(store.versions(input.id).map((value) => value.body)).toEqual([
      two.body,
      one.body,
    ])
    expect(store.resolve([{ id: input.id, revision: 1 }])[0]?.body).toBe(
      one.body
    )
    store.archive(input.id, 2, true)
    expect(() => store.resolve([{ id: input.id, revision: 1 }])).toThrow(
      "archived"
    )
    expect(() => store.save({ ...input, expectedRevision: 2 })).toThrow(
      "Restore"
    )
    store.archive(input.id, 3, false)
    expect(store.save({ ...input, expectedRevision: 2 }).revision).toBe(3)
  })
  it("replays uncertain archival but never undoes a later restore", () => {
    const store = make(),
      skill = store.save(command())
    const archived = store.archive(skill.id, skill.stateRevision, true)
    expect(store.archive(skill.id, skill.stateRevision, true)).toEqual(archived)
    const restored = store.archive(skill.id, archived.stateRevision, false)
    expect(restored.archived).toBe(false)
    expect(() => store.archive(skill.id, skill.stateRevision, true)).toThrow(
      "changed"
    )
    expect(store.list()[0]?.archived).toBe(false)
  })
  it("migrates pre-skill turns without changing prompts or history", () => {
    const db = database()
    db.run(
      "CREATE TABLE chat_turns (id TEXT PRIMARY KEY,text TEXT NOT NULL,status TEXT NOT NULL,answer TEXT NOT NULL DEFAULT '',error TEXT,created_at TEXT NOT NULL,session_id TEXT,prompt TEXT)"
    )
    db.run(
      "INSERT INTO chat_turns VALUES ('old','saved message','running','',NULL,'2026-10-01',NULL,'existing prompt')"
    )
    const turns = new ConversationStore(db, { model: "test", thinking: "off" })
    expect(turns.get("old")).toMatchObject({
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
      skill = owner.save(command())
    const resolve = async (refs: typeof SelectSkills.Type.skills) => ({
      skills: owner.resolve(refs),
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
          () => true
        )
      )
    const refs = [{ id: skill.id, revision: 1 }]
    await select(a, 0, refs)
    expect(b.selection().skills).toEqual([])
    owner.save({ ...skill, expectedRevision: 1, body: "Changed" })
    expect(a.selection().skills[0]?.body).toBe(skill.body)
    owner.archive(skill.id, 2, true)
    expect(await select(a, 1, refs)).toEqual(a.selection())
    await expect(select(b, 0, refs)).rejects.toBeDefined()
    const next = owner.save({ ...command(), name: "Second skill" })
    await select(a, 1, [...refs, { id: next.id, revision: 1 }])
    await expect(select(a, 1, [])).rejects.toMatchObject({
      _tag: "SkillConflict",
    })
    await select(a, 2, [])
    expect(a.selection().skills).toEqual([])
  })
  it("rechecks bot archival after remote resolution and rejects duplicates", async () => {
    const store = make(),
      owner = make(),
      skill = owner.save(command())
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
                  return { skills: owner.resolve(refs), error: null }
                })(references),
              catch: () =>
                new SkillConflict({ message: "Could not load these skills." }),
            }),
          () => writable
        )
      )
    ).rejects.toMatchObject({ _tag: "SkillConflict" })
    expect(store.selection().revision).toBe(0)
    await expect(
      Effect.runPromise(
        selectBotSkills(
          makeSkills(store),
          { ...input, skills: [...input.skills, ...input.skills] },
          () => Effect.succeed({ skills: [], error: null }),
          () => true
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
      skill = owner.save(input)
    let turns = new ConversationStore(db, { model: "test", thinking: "off" })
    const submission = {
      operationId: crypto.randomUUID(),
      text: "Draft a note",
    }
    const admitted = turns.admit(submission, undefined, [skill]).turn
    expect(admitted.skills).toEqual([
      { id: skill.id, name: skill.name, revision: 1 },
    ])
    expect(admitted.skill_context).toContain(skill.body)
    const changed = owner.save({
      ...input,
      expectedRevision: 1,
      body: "A new instruction",
    })
    expect(
      turns.admit(submission, undefined, [changed]).turn.skill_context
    ).toBe(admitted.skill_context)
    turns = new ConversationStore(db, { model: "test", thinking: "off" })
    const steer = turns.admit(
      {
        operationId: crypto.randomUUID(),
        text: "A shorter note",
        mode: "steer",
      },
      undefined,
      [changed]
    ).turn
    expect(steer.skills).toEqual(admitted.skills)
    expect(steer.skill_context).toBe("")
    expect(turns.recent()[0]?.skill_context).toBe("")
    const prompt = skillContext([skill]) + "\nUser: draft a note"
    turns.savePrompt(admitted.id, prompt)
    expect(turns.get(admitted.id)?.prompt).toBe(prompt)
    expect(turns.get(admitted.id)?.skill_context).toBe("")
    expect(turns.recent()[0]?.skills).toEqual(admitted.skills)
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
