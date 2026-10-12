import type { Sqlite } from "../../storage/sqlite"
import {
  TerminalFailure,
  type CommandInput,
  type CommandRun,
  type Checkpoint,
  type CommandSummary,
  type TerminalNetworkPolicy,
} from "../contracts"

export class TerminalStore {
  constructor(
    private readonly db: Sqlite,
    private readonly onFinished?: (run: CommandRun) => void
  ) {
    db.run(
      "CREATE TABLE IF NOT EXISTS terminal_network (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,unrestricted INTEGER NOT NULL)"
    )
    db.run(
      "CREATE TABLE IF NOT EXISTS terminal_runs (id TEXT PRIMARY KEY,created INTEGER NOT NULL,record TEXT NOT NULL)"
    )
    db.run(
      "CREATE TABLE IF NOT EXISTS terminal_checkpoint (id INTEGER PRIMARY KEY CHECK(id=1),record TEXT NOT NULL)"
    )
    db.run(
      "CREATE TABLE IF NOT EXISTS terminal_cancellations (id TEXT PRIMARY KEY)"
    )
    db.run(
      "CREATE TABLE IF NOT EXISTS terminal_authority (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,active INTEGER NOT NULL)"
    )
    if (
      !db
        .all<{ name: string }>("PRAGMA table_info(terminal_authority)")
        .some((column) => column.name === "revoked_through")
    )
      db.run(
        "ALTER TABLE terminal_authority ADD COLUMN revoked_through INTEGER NOT NULL DEFAULT -1"
      )
  }
  networkPolicy(): TerminalNetworkPolicy {
    const row = this.db.all<{ revision: number; unrestricted: number }>(
      "SELECT revision,unrestricted FROM terminal_network WHERE id=1"
    )[0]
    return row
      ? { revision: row.revision, unrestricted: row.unrestricted === 1 }
      : { revision: 0, unrestricted: true }
  }
  configureNetwork(input: TerminalNetworkPolicy) {
    return this.db.transaction(() => {
      if (!this.authority()?.active)
        throw new TerminalFailure({
          message: "Restore this bot before changing its network settings.",
        })
      const current = this.networkPolicy()
      if (current.revision !== input.revision)
        throw new TerminalFailure({
          message: "Network settings changed. Reload before saving again.",
        })
      this.db.run(
        "INSERT INTO terminal_network VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,unrestricted=excluded.unrestricted",
        current.revision + 1,
        input.unrestricted ? 1 : 0
      )
      return this.networkPolicy()
    })
  }
  exported(id: string): Checkpoint | null {
    this.db.run(
      "CREATE TABLE IF NOT EXISTS terminal_exports (id TEXT PRIMARY KEY,record TEXT NOT NULL)"
    )
    const row = this.db.all<{ record: string }>(
      "SELECT record FROM terminal_exports WHERE id=?",
      id
    )[0]
    return row ? (JSON.parse(row.record) as Checkpoint) : null
  }
  cancel(id: string) {
    this.db.run(
      "INSERT OR IGNORE INTO terminal_cancellations (id) VALUES (?)",
      id
    )
    return this.get(id)
      ? this.finish(id, {
          status: "cancelled",
          exitCode: null,
          error:
            "Cancelled. Workspace recovery uses the last saved checkpoint.",
        })
      : null
  }
  authority() {
    return this.db.all<{
      revision: number
      active: number
      revokedThrough: number
    }>(
      "SELECT revision,active,revoked_through AS revokedThrough FROM terminal_authority WHERE id=1"
    )[0]
  }
  configure(
    revision: number,
    active: boolean,
    revokeThrough = active ? -1 : revision
  ) {
    this.db.run(
      "INSERT INTO terminal_authority (id,revision,active,revoked_through) VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=max(terminal_authority.revision,excluded.revision),active=CASE WHEN excluded.revision>terminal_authority.revision THEN excluded.active ELSE terminal_authority.active END,revoked_through=max(terminal_authority.revoked_through,excluded.revoked_through)",
      revision,
      active ? 1 : 0,
      Math.max(revokeThrough, active ? -1 : revision)
    )
  }
  authorized(run: CommandRun) {
    const authority = this.authority()
    return (
      !!authority?.active &&
      (run.authorityRevision ?? -1) > authority.revokedThrough
    )
  }
  get(id: string): CommandRun | undefined {
    const row = this.db.all<{ record: string }>(
      "SELECT record FROM terminal_runs WHERE id=?",
      id
    )[0]
    return row ? (JSON.parse(row.record) as CommandRun) : undefined
  }
  list(): CommandSummary[] {
    return this.db.all<CommandSummary>(
      "SELECT id,substr(json_extract(record,'$.command'),1,100) AS label,json_extract(record,'$.status') AS status,created AS createdAt,json_extract(record,'$.finishedAt') AS finishedAt,json_extract(record,'$.savedAt') AS savedAt FROM terminal_runs ORDER BY created DESC,id DESC LIMIT 20"
    )
  }
  checkpoint(): Checkpoint | null {
    const row = this.db.all<{ record: string }>(
      "SELECT record FROM terminal_checkpoint WHERE id=1"
    )[0]
    return row ? (JSON.parse(row.record) as Checkpoint) : null
  }
  private put(value: CommandRun) {
    this.db.run(
      "INSERT INTO terminal_runs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
      value.id,
      value.createdAt,
      JSON.stringify(value)
    )
    return value
  }
  admit(
    input: CommandInput,
    kind: NonNullable<CommandRun["kind"]> = "command",
    transfer?: CommandRun["transfer"]
  ) {
    return this.db.transaction(() => {
      const previous = this.get(input.id)
      if (previous) {
        if (
          previous.command !== input.command ||
          (previous.kind ?? "command") !== kind ||
          JSON.stringify(previous.transfer) !== JSON.stringify(transfer)
        )
          throw new TerminalFailure({
            message: "This command ID already has different input.",
          })
        return previous
      }
      const authority = this.authority()
      if (!authority?.active || authority.revision <= authority.revokedThrough)
        throw new TerminalFailure({ message: "This bot is not active." })
      const count = this.db.all<{ count: number }>(
        "SELECT count(*) AS count FROM terminal_runs"
      )[0]!.count
      if (count >= 500)
        throw new TerminalFailure({
          message: "This bot has reached its 500-command history limit.",
        })
      const stopped =
        this.db.all(
          "SELECT id FROM terminal_cancellations WHERE id=?",
          input.id
        ).length > 0
      return this.put({
        ...input,
        authorityRevision: authority.revision,
        networkUnrestricted: this.networkPolicy().unrestricted,
        kind,
        ...(transfer ? { transfer } : {}),
        status: stopped ? "cancelled" : "running",
        output: "",
        exitCode: null,
        error: stopped
          ? "Stopped before dispatch. This command was not executed."
          : null,
        createdAt: Date.now(),
        finishedAt: stopped ? Date.now() : null,
        savedAt: null,
      })
    })
  }
  progress(id: string, output: string) {
    const run = this.get(id)
    if (run?.status === "running") this.put({ ...run, output })
  }
  finish(
    id: string,
    result: Pick<CommandRun, "status" | "exitCode" | "error">,
    checkpoint?: Checkpoint,
    exported?: Checkpoint
  ) {
    const changed = this.get(id)?.status === "running"
    const finished = this.db.transaction(() => {
      const run = this.get(id)
      if (!run) throw new TerminalFailure({ message: "Command not found." })
      if (run.status !== "running") return run
      if ((checkpoint || exported) && !this.authorized(run))
        return this.put({
          ...run,
          status: "cancelled",
          exitCode: null,
          error:
            "Bot archived. Workspace recovery uses the last saved checkpoint.",
          finishedAt: Date.now(),
          savedAt: null,
        })
      if (exported) {
        this.db.run(
          "CREATE TABLE IF NOT EXISTS terminal_exports (id TEXT PRIMARY KEY,record TEXT NOT NULL)"
        )
        this.db.run(
          "INSERT INTO terminal_exports VALUES (?,?)",
          id,
          JSON.stringify(exported)
        )
      }
      if (checkpoint)
        this.db.run(
          "INSERT INTO terminal_checkpoint VALUES (1,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
          JSON.stringify(checkpoint)
        )
      return this.put({
        ...run,
        ...result,
        finishedAt: Date.now(),
        savedAt: checkpoint?.savedAt ?? null,
      })
    })
    if (changed) this.observe(finished)
    return finished
  }
  private observe(run: CommandRun) {
    try {
      this.onFinished?.(run)
    } catch {
      /* Telemetry cannot undo a committed receipt. */
    }
  }
  recover() {
    const interrupted = this.db.all<{ id: string }>(
      "SELECT id FROM terminal_runs WHERE json_extract(record,'$.status')='running'"
    )
    this.db.run(
      "UPDATE terminal_runs SET record=json_set(record,'$.status','interrupted','$.finishedAt',?,'$.error','The runtime restarted. This command was not repeated. Workspace recovery uses the last saved checkpoint.') WHERE json_extract(record,'$.status')='running'",
      Date.now()
    )
    for (const { id } of interrupted) this.observe(this.get(id)!)
  }
}
