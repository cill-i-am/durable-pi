import type { Sqlite } from "../../storage/sqlite"
import type { ExecutionRepository } from "../execution"
import {
  ExecutionFailure,
  type RunSummary,
  type CodeRun,
  type CodeOutput,
  type RunInput,
} from "../contracts"

export class ExecutionStore implements ExecutionRepository {
  constructor(private readonly db: Sqlite) {
    db.run(
      "CREATE TABLE IF NOT EXISTS code_runs (id TEXT PRIMARY KEY,created INTEGER NOT NULL,record TEXT NOT NULL)"
    )
  }
  get(id: string): CodeRun | undefined {
    const row = this.db.all<{ record: string }>(
      "SELECT record FROM code_runs WHERE id=?",
      id
    )[0]
    return row ? (JSON.parse(row.record) as CodeRun) : undefined
  }
  list() {
    return this.db.all<RunSummary>(
      `SELECT id, json_extract(record,'$.label') AS label, json_extract(record,'$.status') AS status, created AS createdAt, json_extract(record,'$.finishedAt') AS finishedAt FROM code_runs ORDER BY created DESC,id DESC LIMIT 50`
    )
  }

  private put(run: CodeRun) {
    this.db.run(
      "INSERT INTO code_runs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
      run.id,
      run.createdAt,
      JSON.stringify(run)
    )
    return run
  }
  admit(input: RunInput) {
    return this.db.transaction(() => {
      const previous = this.get(input.id)
      if (previous) {
        if (
          previous.input.code !== input.code ||
          previous.input.data !== input.data
        )
          throw new ExecutionFailure({
            message: "That run ID already belongs to different code or input.",
          })
        return previous
      }
      const counts = this.db.all<{ total: number; running: number }>(
        "SELECT count(*) AS total,coalesce(sum(json_extract(record,'$.status')='running'),0) AS running FROM code_runs"
      )[0]!
      if (counts.running > 0)
        throw new ExecutionFailure({
          message: "Wait for the current run or cancel it first.",
        })
      if (counts.total >= 500)
        throw new ExecutionFailure({
          message: "This bot has reached its 500-run history limit.",
        })
      return this.put({
        id: input.id,
        label: (input.code.split("\n")[0] ?? "").slice(0, 100),
        input: { code: input.code, data: input.data },
        status: "running",
        createdAt: Date.now(),
        finishedAt: null,
        output: null,
      })
    })
  }
  finish(id: string, status: CodeRun["status"], output: CodeOutput | null) {
    return this.db.transaction(() => {
      const run = this.get(id)
      if (!run) throw new ExecutionFailure({ message: "Run not found." })
      if (run.status !== "running") return run
      return this.put({ ...run, status, output, finishedAt: Date.now() })
    })
  }
  recover() {
    this.db.run(
      "UPDATE code_runs SET record=json_set(record,'$.status','interrupted','$.finishedAt',?) WHERE json_extract(record,'$.status')='running'",
      Date.now()
    )
  }
}
