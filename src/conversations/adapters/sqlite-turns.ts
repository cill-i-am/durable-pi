import { ResolvedRoute, type JobType } from "../../inference/policy"
import { SkillReference, type SkillDocument } from "../../skills/contracts"
import type { Sqlite } from "../../storage/sqlite"
import { Schema } from "effect"
import { AttachmentContent, FileInfo } from "../../workspace/files"
import { TurnOrigin } from "../contracts"
import type { StatusTurn } from "../status"
import { RecoveryView } from "../recovery"
import type { ConversationLedger } from "../ledger"
import * as Domain from "../domain"
import {
  ConversationStorageError,
  TurnRecord,
  type PreparedMessage,
  type TurnOutcome,
  type ModelSettings,
  type Submission,
  type Turn,
} from "../turns"

export class ConversationStore implements ConversationLedger {
  readonly transactionGroup: object
  constructor(
    private readonly db: Sqlite,
    private readonly defaults: ModelSettings
  ) {
    this.transactionGroup = db
    const storage = <T>(operation: string, body: () => T): T => {
      try {
        return body()
      } catch (cause) {
        throw new ConversationStorageError({ operation, cause })
      }
    }
    this.db = {
      all: (query, ...bindings) =>
        storage("read", () => db.all(query, ...bindings)),
      run: (query, ...bindings) =>
        storage("write", () => db.run(query, ...bindings)),
      transaction: (body) => {
        const callback: { failed: boolean; cause?: unknown } = { failed: false }
        try {
          return db.transaction(() => {
            try {
              return body()
            } catch (cause) {
              callback.failed = true
              callback.cause = cause
              throw cause
            }
          })
        } catch (cause) {
          if (callback.failed && cause === callback.cause) throw cause
          throw new ConversationStorageError({
            operation: "transaction",
            cause,
          })
        }
      },
    }
    this.db.run(
      "CREATE TABLE IF NOT EXISTS chat_turns (id TEXT PRIMARY KEY,text TEXT NOT NULL,status TEXT NOT NULL,answer TEXT NOT NULL DEFAULT '',error TEXT,created_at TEXT NOT NULL,session_id TEXT,prompt TEXT)"
    )
    const columns = new Set(
      this.db
        .all<{ name: string }>("PRAGMA table_info(chat_turns)")
        .map((row) => row.name)
    )
    for (const [name, definition] of Object.entries({
      parent_id: "TEXT",
      started_at: "TEXT",
      finished_at: "TEXT",
      stopped_at: "TEXT",
      recovery: "TEXT",
      mode: "TEXT NOT NULL DEFAULT 'followUp'",
      delivery: "TEXT NOT NULL DEFAULT 'queued'",
      model: "TEXT",
      routing: "TEXT",
      origin: "TEXT",
      thinking: "TEXT",
      revision: "INTEGER NOT NULL DEFAULT 0",
      creation: "TEXT",
      attachments: "TEXT NOT NULL DEFAULT '[]'",
      input: "TEXT NOT NULL DEFAULT '[]'",
      skills: "TEXT NOT NULL DEFAULT '[]'",
      skill_context: "TEXT NOT NULL DEFAULT ''",
    })) {
      if (!columns.has(name))
        this.db.run(`ALTER TABLE chat_turns ADD COLUMN ${name} ${definition}`)
    }
    this.db.run(
      "CREATE INDEX IF NOT EXISTS chat_turns_parent ON chat_turns(parent_id)"
    )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS job_model_settings (job TEXT PRIMARY KEY,model TEXT NOT NULL,thinking TEXT NOT NULL)"
    )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS chat_settings (id INTEGER PRIMARY KEY,model TEXT NOT NULL,thinking TEXT NOT NULL)"
    )
    if (
      !this.db
        .all<{ name: string }>("PRAGMA table_info(chat_settings)")
        .some((column) => column.name === "revision")
    )
      this.db.run(
        "ALTER TABLE chat_settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 0"
      )
  }
  jobSetting(job: JobType): ModelSettings | undefined {
    if (job === "conversation")
      return this.db.all<ModelSettings>(
        "SELECT model,thinking FROM chat_settings WHERE id=1"
      )[0]
    return this.db.all<ModelSettings>(
      "SELECT model,thinking FROM job_model_settings WHERE job=?",
      job
    )[0]
  }
  setJobSetting(job: JobType, settings: ModelSettings) {
    if (job === "conversation") return this.setSettings(settings)
    this.db.transaction(() => {
      this.setSettings(this.settings())
      this.db.run(
        "INSERT INTO job_model_settings VALUES (?,?,?) ON CONFLICT(job) DO UPDATE SET model=excluded.model,thinking=excluded.thinking",
        job,
        settings.model,
        settings.thinking
      )
    })
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
    const row = this.db.all<StoredTurn>(
      "SELECT * FROM chat_turns WHERE id=?",
      id
    )[0]
    return row ? restore(row) : undefined
  }
  active() {
    const row = this.db.all<StoredTurn>(
      "SELECT * FROM chat_turns WHERE parent_id IS NULL AND status IN ('queued','preparing','running','stopping') ORDER BY rowid LIMIT 1"
    )[0]
    return row ? restore(row) : undefined
  }
  recent() {
    return this.db
      .all<StoredTurn>(
        `SELECT ${visibleColumns} FROM chat_turns WHERE parent_id IS NULL ORDER BY rowid DESC LIMIT 100`
      )
      .reverse()
      .map(restore)
  }
  statusTurns() {
    type Row = { id: string; status: string; recovery: string | null }
    const projection = Schema.decodeUnknownSync(
      Schema.Struct({
        id: Schema.String,
        status: TurnRecord.fields.status,
        phase: Schema.NullOr(RecoveryView.fields.phase),
      })
    )
    const read = (filter: string, order: string): StatusTurn | undefined => {
      const row = this.db.all<Row>(
        `SELECT id,status,recovery FROM chat_turns
         WHERE parent_id IS NULL ${filter} ORDER BY rowid ${order} LIMIT 1`
      )[0]
      if (!row) return
      // Status exposes only these facts, including historical phase-only rows.
      // Parse owned JSON outside the driver so corruption is not an I/O failure.
      const decoded = projection({
        id: row.id,
        status: row.status,
        phase: row.recovery
          ? (JSON.parse(row.recovery)?.view?.phase ?? null)
          : null,
      })
      return {
        id: decoded.id,
        status: decoded.status,
        recovery: decoded.phase ? { phase: decoded.phase } : null,
      }
    }
    return {
      active: read(
        "AND status IN ('queued','preparing','running','stopping')",
        "ASC"
      ),
      latest: read("", "DESC"),
    }
  }
  members(rootId: string, includeInput = true) {
    return this.db
      .all<StoredTurn>(
        `SELECT ${includeInput ? "*" : visibleColumns} FROM chat_turns WHERE id=? OR parent_id=? ORDER BY rowid`,
        rootId,
        rootId
      )
      .map(restore)
  }
  admit(
    input: Submission,
    prepared?: PreparedMessage,
    skills: readonly SkillDocument[] = [],
    resolved?: ResolvedRoute
  ) {
    return this.db.transaction(() => {
      const source = input.retryOf ? this.get(input.retryOf) : undefined
      const origin = input.retryOf ? source?.origin : input.origin
      const creation = Domain.submissionIdentity(input, origin)
      const existing = this.get(input.operationId)
      if (existing) {
        Domain.requireReplay(existing, input, creation)
        return { turn: existing, accepted: false }
      }
      Domain.requireCapacity(
        this.db.all<{ n: number }>(
          "SELECT count(*) AS n FROM chat_turns WHERE status IN ('queued','preparing','running','stopping')"
        )[0]!.n
      )
      Domain.requireRetry(input, source)
      const parent = Domain.admissionParent(input, this.active())
      Domain.requireSteer(
        parent,
        input,
        (parent
          ? this.members(parent.id, false).reduce(
              (count, member) => count + member.attachments.length,
              0
            )
          : 0) + (prepared?.files.length ?? 0)
      )
      const job = input.job ?? "conversation"
      const settings = Domain.admissionRoute(input, {
        parent,
        source,
        resolved,
        defaults: this.defaults,
        jobSetting:
          parent || source || resolved ? undefined : this.jobSetting(job),
      })
      const content = Domain.admissionContent(parent, skills, prepared)
      this.db.run(
        "INSERT INTO chat_turns(id,text,status,created_at,parent_id,mode,model,thinking,creation,attachments,input,skills,skill_context,routing,origin) VALUES (?,?,'queued',?,?,?,?,?,?,?,?,?,?,?,?)",
        input.operationId,
        input.text,
        new Date().toISOString(),
        parent?.id ?? null,
        input.mode ?? "followUp",
        settings.model,
        settings.thinking,
        creation,
        JSON.stringify(content.attachments),
        JSON.stringify(content.input),
        JSON.stringify(content.skills),
        content.skill_context,
        JSON.stringify(settings),
        origin ? JSON.stringify(origin) : null
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
    this.updateIf(
      id,
      Domain.canPrepare,
      "UPDATE chat_turns SET status='preparing' WHERE id=?"
    )
  }
  savePrompt(id: string, prompt: string) {
    this.updateIf(
      id,
      Domain.canSavePrompt,
      "UPDATE chat_turns SET prompt=?,input='[]',skill_context='' WHERE id=?",
      prompt
    )
  }
  saveSession(id: string, session: string) {
    this.updateIf(
      id,
      Domain.canSaveSession,
      "UPDATE chat_turns SET session_id=? WHERE id=?",
      session
    )
  }
  submitted(id: string, session: string) {
    this.db.transaction(() => {
      const turn = this.get(id)
      if (!turn || !Domain.canSubmit(turn)) return
      this.db.run(
        "UPDATE chat_turns SET session_id=?,status='running',started_at=coalesce(started_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),delivery=? WHERE id=?",
        session,
        Domain.submittedDelivery(turn),
        id
      )
    })
  }
  consumed(id: string) {
    this.updateIf(
      id,
      Domain.canConsume,
      "UPDATE chat_turns SET delivery='consumed' WHERE id=?"
    )
  }
  requestStop(id: string) {
    return this.db.transaction(() => {
      const turn = this.get(id)
      const rootId = Domain.stopRoot(turn)
      if (!rootId) return
      const next = Domain.stopTransition(turn, this.get(rootId))
      if (!next) return
      if (next.change)
        this.db.run(
          "UPDATE chat_turns SET status='stopping',stopped_at=coalesce(stopped_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),revision=revision+1 WHERE id=?",
          next.rootId
        )
      return next.rootId
    })
  }
  finish(
    root: Turn,
    outcomes: readonly TurnOutcome[],
    answer: string,
    error: string | null
  ) {
    return this.db.transaction(() => {
      const current = this.get(root.id)!
      const next = Domain.finishTransition(
        root,
        current,
        this.members(root.id),
        outcomes,
        answer,
        error
      )
      if (!next) return false
      for (const outcome of next.members) {
        this.db.run(
          "UPDATE chat_turns SET status=?,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),delivery=?,input='[]',prompt=NULL,skill_context='' WHERE id=?",
          outcome.status,
          outcome.delivery,
          outcome.id
        )
      }
      this.db.run(
        "UPDATE chat_turns SET answer=?,error=? WHERE id=?",
        next.answer,
        next.error,
        root.id
      )
      return true
    })
  }
  private updateIf(
    id: string,
    eligible: (turn: Turn) => boolean,
    query: string,
    ...bindings: (string | number | null)[]
  ) {
    this.db.transaction(() => {
      const turn = this.get(id)
      if (turn && eligible(turn)) this.db.run(query, ...bindings, id)
    })
  }
}

type StoredTurn = Omit<
  Turn,
  "attachments" | "input" | "skills" | "routing" | "origin"
> & {
  origin: string | null
  routing: string | null
  attachments: string
  input: string
  skills: string
}
const visibleColumns =
  "id,text,status,answer,error,created_at,session_id,NULL AS prompt,parent_id,mode,delivery,model,thinking,routing,origin,revision,creation,attachments,skills,'' AS skill_context,'[]' AS input"
function restore(row: StoredTurn): Turn {
  const decoded = Schema.decodeUnknownSync(TurnRecord)({
    ...row,
    origin: row.origin
      ? Schema.decodeUnknownSync(TurnOrigin)(JSON.parse(row.origin))
      : undefined,
    routing: row.routing
      ? Schema.decodeUnknownSync(ResolvedRoute)(JSON.parse(row.routing))
      : null,
    skills: Schema.decodeUnknownSync(Schema.Array(SkillReference))(
      JSON.parse(row.skills)
    ),
    attachments: Schema.decodeUnknownSync(Schema.Array(FileInfo))(
      JSON.parse(row.attachments)
    ),
    input: Schema.decodeUnknownSync(Schema.Array(AttachmentContent))(
      JSON.parse(row.input)
    ),
  })
  return { ...row, ...decoded, origin: decoded.origin }
}
