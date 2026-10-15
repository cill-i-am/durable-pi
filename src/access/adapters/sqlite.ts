import type { Sqlite } from "../../storage/sqlite"
import {
  AccessStorageError,
  type AccessMode,
  type Approval,
  type ToolPolicy,
} from "../contracts"

import type { AccessLedger, ToolIntent, ToolOperation } from "../ledger"
import * as Domain from "../domain"

export class AccessStore implements AccessLedger {
  constructor(
    private readonly db: Sqlite,
    private readonly catalog: () => readonly Omit<ToolPolicy, "revision">[],
    private readonly now = Date.now
  ) {
    const storage = <T>(operation: string, body: () => T): T => {
      try {
        return body()
      } catch (cause) {
        throw new AccessStorageError({ operation, cause })
      }
    }
    this.db = {
      all: (query, ...bindings) =>
        storage("read", () => db.all(query, ...bindings)),
      run: (query, ...bindings) =>
        storage("write", () => db.run(query, ...bindings)),
      transaction: (body) => {
        const failure: { failed: boolean; cause?: unknown } = { failed: false }
        try {
          return db.transaction(() => {
            try {
              return body()
            } catch (cause) {
              failure.failed = true
              failure.cause = cause
              throw cause
            }
          })
        } catch (cause) {
          if (failure.failed && cause === failure.cause) throw cause
          throw new AccessStorageError({ operation: "transaction", cause })
        }
      },
    }

    this.db.run(
      "CREATE TABLE IF NOT EXISTS tool_grants (name TEXT PRIMARY KEY,mode TEXT NOT NULL,revision INTEGER NOT NULL)"
    )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS tool_operations (id TEXT PRIMARY KEY,turnId TEXT NOT NULL,tool TEXT NOT NULL,input TEXT NOT NULL,createdAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL,status TEXT NOT NULL,grantRevision INTEGER NOT NULL,result TEXT)"
    )
    if (
      !this.db
        .all<{ name: string }>("PRAGMA table_info(tool_operations)")
        .some((column) => column.name === "revision")
    )
      this.db.run(
        "ALTER TABLE tool_operations ADD COLUMN revision INTEGER NOT NULL DEFAULT 0"
      )
    if (
      !this.db
        .all<{ name: string }>("PRAGMA table_info(tool_operations)")
        .some((column) => column.name === "decision")
    )
      this.db.run("ALTER TABLE tool_operations ADD COLUMN decision TEXT")
    this.db.run(`CREATE TABLE IF NOT EXISTS tool_operation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, operationId TEXT NOT NULL, revision INTEGER NOT NULL,
      status TEXT NOT NULL, at INTEGER NOT NULL)`)
    this.db
      .run(`CREATE TRIGGER IF NOT EXISTS tool_operation_insert AFTER INSERT ON tool_operations
      BEGIN INSERT INTO tool_operation_history(operationId,revision,status,at) VALUES (new.id,new.revision,new.status,new.createdAt); END`)
    this.db
      .run(`CREATE TRIGGER IF NOT EXISTS tool_operation_status AFTER UPDATE OF status ON tool_operations
      WHEN old.status != new.status
      BEGIN INSERT INTO tool_operation_history(operationId,revision,status,at) VALUES (new.id,new.revision,new.status,
        max(new.createdAt,cast((julianday('now')-2440587.5)*86400000 AS INTEGER))); END`)
    this.db.run(
      "CREATE INDEX IF NOT EXISTS tool_operation_history_operation ON tool_operation_history(operationId,id)"
    )
    this.db.run(
      "CREATE INDEX IF NOT EXISTS tool_operations_run ON tool_operations(turnId,createdAt,id)"
    )
  }
  policies(): ToolPolicy[] {
    const saved = new Map(
      this.db
        .all<{ name: string; mode: AccessMode; revision: number }>(
          "SELECT name,mode,revision FROM tool_grants"
        )
        .map((value) => [value.name, value])
    )
    return this.catalog().map((tool) => ({
      ...tool,
      revision: 0,
      ...saved.get(tool.name),
    }))
  }
  policy(name: string) {
    return Domain.requirePolicy(
      this.policies().find((tool) => tool.name === name)
    )
  }
  update(name: string, expectedRevision: number, mode: AccessMode) {
    return this.db.transaction(() => {
      const current = this.policy(name)
      const next = Domain.revisePolicy(current, expectedRevision, mode)
      if (next === current) return current
      this.db.run(
        "INSERT INTO tool_grants VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET mode=excluded.mode,revision=excluded.revision",
        name,
        next.mode,
        next.revision
      )
      if (next.mode === "deny")
        this.db.run(
          "UPDATE tool_operations SET status='denied',revision=revision+1 WHERE tool=? AND status IN ('pending','approved')",
          name
        )
      return this.policy(name)
    })
  }

  get(id: string) {
    return this.db.all<ToolOperation>(
      "SELECT * FROM tool_operations WHERE id=?",
      id
    )[0]
  }
  receipts(turnIds: readonly string[]) {
    if (!turnIds.length) return []
    return this.db.all<{ id: string; revision: number }>(
      `SELECT id,revision FROM tool_operations WHERE turnId IN (${turnIds.map(() => "?").join(",")}) AND status='done' AND tool NOT IN ('update_plan','read_plan') ORDER BY createdAt DESC LIMIT 20`,
      ...turnIds
    )
  }
  expire() {
    this.db.run(
      "UPDATE tool_operations SET status='expired',revision=revision+1 WHERE expiresAt<=? AND status IN ('pending','approved')",
      this.now()
    )
  }
  pending() {
    this.expire()
    return this.db.all<Approval>(
      "SELECT id,turnId,tool,input,createdAt,expiresAt,status,revision FROM tool_operations WHERE status IN ('pending','approved') ORDER BY createdAt,id"
    )
  }
  awaitingApproval(turnId: string) {
    return !!this.db.all<{ id: string }>(
      "SELECT id FROM tool_operations WHERE turnId=? AND status='pending' AND expiresAt>? LIMIT 1",
      turnId,
      this.now()
    )[0]
  }
  begin(input: ToolIntent) {
    return this.db.transaction(() => {
      this.expire()
      const existing = Domain.replayIntent(input, this.get(input.id))
      if (existing) return existing
      const operation = Domain.admitOperation(
        input,
        this.policy(input.tool),
        this.pending().length,
        this.now()
      )
      this.db.run(
        "INSERT INTO tool_operations (id,turnId,tool,input,createdAt,expiresAt,status,grantRevision) VALUES (?,?,?,?,?,?,?,?)",
        operation.id,
        operation.turnId,
        operation.tool,
        operation.input,
        operation.createdAt,
        operation.expiresAt,
        operation.status,
        operation.grantRevision
      )
      return this.get(input.id)!
    })
  }
  decide(
    id: string,
    approve: boolean,
    expectedRevision: number,
    remember?: { expectedPolicyRevision: number }
  ) {
    const decision = Domain.decisionIdentity(
      approve,
      expectedRevision,
      remember
    )
    this.expire()
    return this.db.transaction(() => {
      const round = Domain.approvalRound(
        this.get(id),
        approve,
        expectedRevision,
        decision,
        remember
      )
      if (round.replay) return round.operation
      const change = Domain.decideOperation(
        round.operation,
        this.policy(round.operation.tool),
        approve,
        decision,
        remember
      )
      const operation = change.operation
      if (change.grant)
        this.db.run(
          "INSERT INTO tool_grants VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET mode=excluded.mode,revision=excluded.revision",
          operation.tool,
          change.grant.mode,
          change.grant.revision
        )
      this.db.run(
        "UPDATE tool_operations SET status=?,grantRevision=?,decision=?,revision=revision+1 WHERE id=?",
        operation.status,
        operation.grantRevision,
        operation.decision,
        id
      )
      return this.get(id)!
    })
  }
  claim(
    id: string,
    recoverable = false
  ): "pending" | "execute" | { result: string } {
    this.expire()
    const decision = this.db.transaction(() => {
      const operation = Domain.requireOperation(this.get(id))
      const change = Domain.claimOperation(
        operation,
        this.policy(operation.tool),
        recoverable,
        this.now()
      )
      if (change.update)
        this.db.run(
          "UPDATE tool_operations SET status=?,grantRevision=?,revision=revision+1 WHERE id=?",
          change.update.status,
          change.update.grantRevision,
          id
        )
      return change.decision
    })
    if (typeof decision === "object" && "_tag" in decision) throw decision
    return decision
  }
  finish(id: string, result: string) {
    Domain.validateResult(result)
    this.db.run(
      "UPDATE tool_operations SET status='done',result=?,revision=revision+1 WHERE id=? AND status='running'",
      result,
      id
    )
  }

  cancel(turnId: string) {
    this.db.run(
      "UPDATE tool_operations SET status='cancelled',revision=revision+1 WHERE turnId=? AND status IN ('pending','approved')",
      turnId
    )
  }
  revoke(name: string) {
    this.db.run(
      "UPDATE tool_grants SET mode='ask',revision=revision+1 WHERE name=?",
      name
    )
    this.db.run(
      "UPDATE tool_operations SET status='denied',revision=revision+1 WHERE tool=? AND status IN ('pending','approved')",
      name
    )
  }
}
