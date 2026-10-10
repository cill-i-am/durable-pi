import type { Sqlite } from "../../storage/sqlite"
import {
  ConversationConflict,
  ConversationFull,
  isPending,
  type Delivery,
  type ModelSettings,
  type Submission,
  type Turn,
} from "../turns"

/** A reply owns its steering inputs. The host queue owns fresh, settled-memory follow-ups. */
export class ConversationStore {
  constructor(
    private readonly db: Sqlite,
    private readonly defaults: ModelSettings
  ) {
    db.run(
      "CREATE TABLE IF NOT EXISTS chat_turns (id TEXT PRIMARY KEY,text TEXT NOT NULL,status TEXT NOT NULL,answer TEXT NOT NULL DEFAULT '',error TEXT,created_at TEXT NOT NULL,session_id TEXT,prompt TEXT)"
    )
    const columns = new Set(
      db
        .all<{ name: string }>("PRAGMA table_info(chat_turns)")
        .map((row) => row.name)
    )
    for (const [name, definition] of Object.entries({
      parent_id: "TEXT",
      mode: "TEXT NOT NULL DEFAULT 'followUp'",
      delivery: "TEXT NOT NULL DEFAULT 'queued'",
      model: "TEXT",
      thinking: "TEXT",
      revision: "INTEGER NOT NULL DEFAULT 0",
      creation: "TEXT",
    })) {
      if (!columns.has(name))
        db.run(`ALTER TABLE chat_turns ADD COLUMN ${name} ${definition}`)
    }
    db.run(
      "CREATE INDEX IF NOT EXISTS chat_turns_parent ON chat_turns(parent_id)"
    )
    db.run(
      "CREATE TABLE IF NOT EXISTS chat_settings (id INTEGER PRIMARY KEY,model TEXT NOT NULL,thinking TEXT NOT NULL)"
    )
    if (
      !db
        .all<{ name: string }>("PRAGMA table_info(chat_settings)")
        .some((column) => column.name === "revision")
    )
      db.run(
        "ALTER TABLE chat_settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 0"
      )
  }
  settings(): ModelSettings {
    return (
      this.db.all<ModelSettings>(
        "SELECT model,thinking FROM chat_settings WHERE id=1"
      )[0] ?? this.defaults
    )
  }
  setSettings(settings: ModelSettings) {
    this.db.run(
      "INSERT INTO chat_settings VALUES (1,?,?,1) ON CONFLICT(id) DO UPDATE SET model=excluded.model,thinking=excluded.thinking,revision=chat_settings.revision+1",
      settings.model,
      settings.thinking
    )
    return this.selection()
  }
  selection() {
    return {
      ...this.settings(),
      settingsRevision:
        this.db.all<{ revision: number }>(
          "SELECT revision FROM chat_settings WHERE id=1"
        )[0]?.revision ?? 0,
    }
  }
  get(id: string) {
    return this.db.all<Turn>("SELECT * FROM chat_turns WHERE id=?", id)[0]
  }
  active() {
    return this.db.all<Turn>(
      "SELECT * FROM chat_turns WHERE parent_id IS NULL AND status IN ('queued','preparing','running','stopping') ORDER BY rowid LIMIT 1"
    )[0]
  }
  recent() {
    return this.db
      .all<Turn>(
        "SELECT * FROM chat_turns WHERE parent_id IS NULL ORDER BY rowid DESC LIMIT 100"
      )
      .reverse()
  }
  members(rootId: string) {
    return this.db.all<Turn>(
      "SELECT * FROM chat_turns WHERE id=? OR parent_id=? ORDER BY rowid",
      rootId,
      rootId
    )
  }
  admit(input: Submission) {
    return this.db.transaction(() => {
      const creation = JSON.stringify({
        text: input.text,
        mode: input.mode ?? "followUp",
        retryOf: input.retryOf ?? null,
      })
      const existing = this.get(input.operationId)
      if (existing) {
        if (
          existing.creation
            ? existing.creation !== creation
            : existing.text !== input.text ||
              (input.mode ?? "followUp") !== "followUp"
        )
          throw new ConversationConflict({
            message: "That operation ID belongs to another message.",
          })
        return { turn: existing, accepted: false }
      }
      if (
        this.db.all<{ n: number }>(
          "SELECT count(*) AS n FROM chat_turns WHERE status IN ('queued','preparing','running','stopping')"
        )[0]!.n >= 10
      )
        throw new ConversationFull()
      if (input.retryOf) {
        const source = this.get(input.retryOf)
        if (!source || !["failed", "cancelled"].includes(source.status))
          throw new ConversationConflict({
            message: "Only an interrupted reply can be retried.",
          })
      }
      const active = this.active()
      const parent =
        input.mode === "steer" && active?.status !== "stopping"
          ? active
          : undefined
      const settings = parent
        ? {
            model: parent.model ?? this.defaults.model,
            thinking: parent.thinking ?? this.defaults.thinking,
          }
        : this.settings()
      this.db.run(
        "INSERT INTO chat_turns(id,text,status,created_at,parent_id,mode,model,thinking,creation) VALUES (?,?,'queued',?,?,?,?,?,?)",
        input.operationId,
        input.text,
        new Date().toISOString(),
        parent?.id ?? null,
        input.mode ?? "followUp",
        settings.model,
        settings.thinking,
        creation
      )
      if (parent)
        this.db.run(
          "UPDATE chat_turns SET revision=revision+1 WHERE id=?",
          parent.id
        )
      return { turn: this.get(input.operationId)!, accepted: true }
    })
  }
  prepare(id: string) {
    this.db.run(
      "UPDATE chat_turns SET status='preparing' WHERE id=? AND status='queued'",
      id
    )
  }
  savePrompt(id: string, prompt: string) {
    this.db.run(
      "UPDATE chat_turns SET prompt=? WHERE id=? AND prompt IS NULL",
      prompt,
      id
    )
  }
  saveSession(id: string, session: string) {
    this.db.run(
      "UPDATE chat_turns SET session_id=? WHERE id=? AND session_id IS NULL",
      session,
      id
    )
  }
  submitted(id: string, session: string) {
    this.db.run(
      "UPDATE chat_turns SET session_id=?,status='running',delivery=CASE WHEN delivery='queued' THEN 'accepted' ELSE delivery END WHERE id=? AND status IN ('queued','preparing','running')",
      session,
      id
    )
  }
  consumed(id: string) {
    this.db.run(
      "UPDATE chat_turns SET delivery='consumed' WHERE id=? AND delivery IN ('queued','accepted')",
      id
    )
  }
  requestStop(id: string) {
    return this.db.transaction(() => {
      const turn = this.get(id)
      if (!turn || !isPending(turn)) return
      const root = this.get(turn.parent_id ?? turn.id)!
      if (isPending(root))
        this.db.run(
          "UPDATE chat_turns SET status='stopping',revision=revision+1 WHERE id=?",
          root.id
        )
      return root.id
    })
  }
  /** A newly accepted steer or stop invalidates a finalization prepared before that admission. */
  finish(
    root: Turn,
    outcomes: readonly {
      id: string
      delivery: Extract<Delivery, "answered" | "unanswered">
    }[],
    answer: string,
    error: string | null
  ) {
    return this.db.transaction(() => {
      const current = this.get(root.id)!
      if (current.revision !== root.revision || !isPending(current))
        return false
      const members = this.members(root.id)
      if (
        members.length !== outcomes.length ||
        members.some(
          (member) => !outcomes.some((outcome) => outcome.id === member.id)
        )
      )
        return false
      const stopped = current.status === "stopping"
      for (const outcome of outcomes) {
        this.db.run(
          "UPDATE chat_turns SET status=?,delivery=? WHERE id=?",
          outcome.id === root.id && stopped
            ? "cancelled"
            : outcome.delivery === "answered"
              ? "done"
              : stopped
                ? "cancelled"
                : "failed",
          outcome.delivery,
          outcome.id
        )
      }
      this.db.run(
        "UPDATE chat_turns SET answer=?,error=? WHERE id=?",
        answer,
        stopped ? null : error,
        root.id
      )
      return true
    })
  }
}
