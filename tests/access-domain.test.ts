import { expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { claimOperation } from "../src/access/domain"
import { AccessDenied } from "../src/access/contracts"
import type { ToolOperation } from "../src/access/ledger"

const revision = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 1000 })
)
const mode = Schema.Literals(["ask", "allow"])
const operation: ToolOperation = {
  id: "operation",
  turnId: "turn",
  tool: "test",
  input: "{}",
  createdAt: 0,
  expiresAt: 1000,
  revision: 1,
  grantRevision: 0,
  status: "running",
  decision: null,
  result: null,
}

it.effect.prop(
  "never redispatches an uncertain nonrecoverable operation after grant changes",
  [revision, mode],
  ([value, access]) =>
    Effect.sync(() => {
      const transition = claimOperation(
        operation,
        { name: "test", description: "Test", mode: access, revision: value },
        false,
        1
      )
      expect(transition.decision).toBeInstanceOf(AccessDenied)
      expect(transition.update?.status).toBe("interrupted")
    })
)

it.effect.prop(
  "recoverable dispatch requires the original grant and an unexpired deadline",
  [revision, Schema.Boolean, mode],
  ([value, expired, access]) =>
    Effect.sync(() => {
      const transition = claimOperation(
        operation,
        { name: "test", description: "Test", mode: access, revision: value },
        true,
        expired ? 1000 : 999
      )
      if (value === 0 && !expired) {
        expect(transition.decision).toBe("execute")
        expect(transition.update?.status).toBe("running")
      } else {
        expect(transition.decision).toBeInstanceOf(AccessDenied)
        expect(transition.update?.status).toBe(expired ? "expired" : "denied")
      }
    })
)
