import { expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

import { advanceCommandRecord } from "../src/terminal/command.machine"
import type { CommandRun } from "../src/terminal/contracts"
import {
  authorized,
  SESSION_LIFETIME,
  sessionExpiry,
} from "../src/terminal/domain"

const revision = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 1000 })
)
const run: CommandRun = {
  id: "command",
  command: "echo saved",
  authorityRevision: 1,
  status: "running",
  output: "",
  exitCode: null,
  error: null,
  createdAt: 0,
  finishedAt: null,
  savedAt: null,
}

it.effect.prop(
  "a revocation fence prevents checkpoint publication regardless of a later restore",
  [revision],
  ([value]) =>
    Effect.sync(() => {
      const command = { ...run, authorityRevision: value }
      const allowed = authorized(command, {
        active: 1,
        revision: value + 1,
        revokedThrough: value,
      })
      expect(allowed).toBe(false)
      const finished = advanceCommandRecord(command, {
        type: "FINISH",
        attemptId: `legacy:${command.id}`,
        result: { status: "succeeded", exitCode: 0, error: null },
        cancelled: false,
        publishing: true,
        allowed,
        savedAt: 42,
        now: 100,
      })
      expect(finished.status).toBe("cancelled")
      expect(finished.savedAt).toBeNull()
    })
)

it.effect.prop(
  "session renewal never extends its fixed lifetime",
  [revision],
  ([value]) =>
    Effect.sync(() => {
      const expiry = sessionExpiry(value * 1000, SESSION_LIFETIME)
      expect(expiry).toBeLessThanOrEqual(SESSION_LIFETIME)
    })
)
