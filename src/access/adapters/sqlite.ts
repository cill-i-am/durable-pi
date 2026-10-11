import type { Sqlite } from "../../storage/sqlite"
import {
  AccessConflict,
  AccessDenied,
  type AccessMode,
  type Approval,
  type ToolPolicy,
} from "../contracts"

export type ToolIntent = {
  id: string
  turnId: string
  tool: string
  input: string
}
type Operation = Approval & { grantRevision: number; result: string | null }
/** Durable approval and execution receipts belong to the bot that owns the tool call. */
export class AccessStore {
  constructor(
    private readonly db: Sqlite,
    private readonly catalog: () => readonly Omit<ToolPolicy, "revision">[],
    private readonly now = Date.now
  ) {
    db.run(
      "CREATE TABLE IF NOT EXISTS tool_grants (name TEXT PRIMARY KEY,mode TEXT NOT NULL,revision INTEGER NOT NULL)"
    )
    db.run(
      "CREATE TABLE IF NOT EXISTS tool_operations (id TEXT PRIMARY KEY,turnId TEXT NOT NULL,tool TEXT NOT NULL,input TEXT NOT NULL,createdAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL,status TEXT NOT NULL,grantRevision INTEGER NOT NULL,result TEXT)"
    )
    if (
      !db
        .all<{ name: string }>("PRAGMA table_info(tool_operations)")
        .some((column) => column.name === "revision")
    )
      db.run(
        "ALTER TABLE tool_operations ADD COLUMN revision INTEGER NOT NULL DEFAULT 0"
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
    const value = this.policies().find((tool) => tool.name === name)
    if (!value) throw new AccessDenied({ message: "This tool is unavailable." })
    return value
  }
  update(name: string, expectedRevision: number, mode: AccessMode) {
    return this.db.transaction(() => {
      const current = this.policy(name)
      if (
        current.mode === mode &&
        (current.revision === expectedRevision ||
          current.revision === expectedRevision + 1)
      )
        return current
      if (current.revision !== expectedRevision)
        throw new AccessConflict({
          message: "Tool access changed. Reload before updating it.",
        })
      this.db.run(
        "INSERT INTO tool_grants VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET mode=excluded.mode,revision=excluded.revision",
        name,
        mode,
        current.revision + 1
      )
      // Revocation is sticky for existing calls, even if the tool is allowed again later.
      if (mode === "deny")
        this.db.run(
          "UPDATE tool_operations SET status='denied',revision=revision+1 WHERE tool=? AND status IN ('pending','approved')",
          name
        )
      return this.policy(name)
    })
  }
  get(id: string) {
    return this.db.all<Operation>(
      "SELECT * FROM tool_operations WHERE id=?",
      id
    )[0]
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
  begin(input: ToolIntent) {
    return this.db.transaction(() => {
      this.expire()
      const existing = this.get(input.id)
      if (existing) {
        if (existing.tool !== input.tool || existing.input !== input.input)
          throw new AccessConflict({
            message: "Tool operation identity does not match.",
          })
        return existing
      }
      const policy = this.policy(input.tool)
      if (policy.mode === "deny")
        throw new AccessDenied({
          message: "This tool is denied by the bot's access policy.",
        })
      if (input.input.length > 64_000)
        throw new AccessDenied({
          message: "Tool arguments exceed the approval limit.",
        })
      if (this.pending().length >= 20)
        throw new AccessDenied({
          message:
            "Resolve the pending approvals before requesting more tools.",
        })
      const now = this.now()
      this.db.run(
        "INSERT INTO tool_operations (id,turnId,tool,input,createdAt,expiresAt,status,grantRevision) VALUES (?,?,?,?,?,?,?,?)",
        input.id,
        input.turnId,
        input.tool,
        input.input,
        now,
        now + 15 * 60_000,
        policy.mode === "ask" ? "pending" : "approved",
        policy.revision
      )
      return this.get(input.id)!
    })
  }
  decide(id: string, approve: boolean, expectedRevision: number) {
    this.expire()
    return this.db.transaction(() => {
      const operation = this.get(id)
      if (!operation)
        throw new AccessConflict({ message: "This approval no longer exists." })
      if (
        operation.status === (approve ? "approved" : "denied") &&
        operation.revision === expectedRevision + 1
      )
        return operation
      if (
        operation.status !== "pending" ||
        operation.revision !== expectedRevision
      )
        throw new AccessConflict({
          message: "This approval has already ended. Refresh the conversation.",
        })
      const policy = this.policy(operation.tool)
      if (approve && policy.mode === "deny")
        throw new AccessDenied({
          message: "This tool has been denied. Update its access policy first.",
        })
      this.db.run(
        "UPDATE tool_operations SET status=?,grantRevision=?,revision=revision+1 WHERE id=?",
        approve ? "approved" : "denied",
        policy.revision,
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
    const decision = this.db.transaction<
      "pending" | "execute" | { result: string } | AccessDenied
    >(() => {
      const operation = this.get(id)
      if (!operation)
        throw new AccessDenied({
          message: "This tool operation is unavailable.",
        })
      const policy = this.policy(operation.tool)
      if (policy.mode === "deny")
        throw new AccessDenied({ message: "Tool access has been revoked." })
      if (operation.status === "done" && operation.result !== null)
        return { result: operation.result }
      // A native document receipt permits replay, never a new authorization.
      // Fence old dispatches even if a revoked policy has since been reallowed.
      if (
        operation.status === "running" &&
        recoverable &&
        (operation.expiresAt <= this.now() ||
          operation.grantRevision !== policy.revision)
      ) {
        const expired = operation.expiresAt <= this.now()
        this.db.run(
          "UPDATE tool_operations SET status=?,revision=revision+1 WHERE id=?",
          expired ? "expired" : "denied",
          id
        )
        return new AccessDenied({
          message: expired
            ? "This interrupted tool request has expired. Read current state before requesting a new change."
            : "Tool access changed after dispatch. Read current state before requesting a new change.",
        })
      }
      if (operation.status === "running" && !recoverable) {
        this.db.run(
          "UPDATE tool_operations SET status='interrupted',revision=revision+1 WHERE id=?",
          id
        )
        return new AccessDenied({
          message:
            "This tool was interrupted after it started. Its outcome is unknown; check before retrying.",
        })
      }
      if (
        !["pending", "approved"].includes(operation.status) &&
        !(recoverable && operation.status === "running")
      )
        throw new AccessDenied({
          message: `This tool request is ${operation.status}.`,
        })
      if (
        policy.mode === "ask" &&
        ((operation.status !== "approved" &&
          !(recoverable && operation.status === "running")) ||
          operation.grantRevision !== policy.revision)
      ) {
        if (
          operation.status !== "pending" ||
          operation.grantRevision !== policy.revision
        )
          this.db.run(
            "UPDATE tool_operations SET status='pending',grantRevision=?,revision=revision+1 WHERE id=?",
            policy.revision,
            id
          )
        return "pending"
      }
      this.db.run(
        "UPDATE tool_operations SET status='running',revision=revision+1 WHERE id=?",
        id
      )
      return "execute"
    })
    if (decision instanceof AccessDenied) throw decision
    return decision
  }
  finish(id: string, result: string) {
    if (result.length > 250_000)
      throw new AccessDenied({
        message: "Tool output exceeded its stored result limit.",
      })
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
