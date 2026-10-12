import { Effect } from "effect"
import { OperationalLogger } from "./logger"
import type { CommandRun } from "../terminal/contracts"
import type { RecoveryView } from "../conversations/recovery"
import type { Attempt } from "../inference/usage"

/** Observations only. Durable domain records remain the source of truth. */
export function inferenceFields(attempt: Attempt, botId?: string) {
  return {
    event: "inference.finished",
    botId: botId ?? null,
    runId: attempt.turnId,
    attemptId: attempt.id,
    turnId: attempt.turnId,
    model: attempt.route.model,
    thinking: attempt.route.thinking,
    job: attempt.route.job,
    purpose: attempt.purpose,
    outcome: attempt.outcome,
    elapsedMs:
      attempt.finishedAt && attempt.outcome !== "interrupted"
        ? Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt)
        : null,
    inputTokens: attempt.input,
    cachedInputTokens: attempt.cached,
    uncachedInputTokens:
      attempt.input !== null && attempt.cached !== null
        ? Math.max(0, attempt.input - attempt.cached)
        : null,
    outputTokens: attempt.output,
  }
}

// Native Pi callbacks are synchronous. Logging has no network/exporter lifetime.
export function reportInference(attempt: Attempt, botId?: string) {
  Effect.runSync(
    (attempt.outcome === "failed" || attempt.outcome === "incomplete"
      ? Effect.logError("Inference.requestFailed")
      : Effect.logInfo("Inference.requestFinished")
    ).pipe(
      Effect.annotateLogs(inferenceFields(attempt, botId)),
      Effect.provide(OperationalLogger)
    )
  )
}

export function reportHarness(error: unknown, kind: "personal" | "background") {
  Effect.runSync(
    Effect.logError("Harness.operationFailed", error).pipe(
      Effect.annotateLogs({ event: "harness.operation_failed", harness: kind }),
      Effect.provide(OperationalLogger)
    )
  )
}

export function reportTerminal(run: CommandRun) {
  Effect.runSync(
    (run.status === "failed" || run.status === "interrupted"
      ? Effect.logError("Terminal.commandFailed")
      : Effect.logInfo("Terminal.commandFinished")
    ).pipe(
      Effect.annotateLogs({
        event: "terminal.finished",
        operationId: run.id,
        outcome: run.status,
        exitCode: run.exitCode,
        elapsedMs:
          run.finishedAt === null ? null : run.finishedAt - run.createdAt,
        checkpointSaved: run.savedAt !== null,
        networkUnrestricted: run.networkUnrestricted ?? false,
      }),
      Effect.provide(OperationalLogger)
    )
  )
}

export function reportRecovery(
  runId: string,
  view: RecoveryView,
  botId?: string
) {
  Effect.runSync(
    Effect.logInfo("Conversation.recoveryChanged").pipe(
      Effect.annotateLogs({
        event: "conversation.recovery",
        botId: botId ?? null,
        runId,
        phase: view.phase,
        tool: view.tool,
        failures: view.failures,
        remaining: view.remaining,
        reason: view.reason,
      }),
      Effect.provide(OperationalLogger)
    )
  )
}

export function reportService(
  error: unknown,
  service: "agent" | "website" | "execution"
) {
  Effect.runSync(
    Effect.logError("Service.requestFailed", error).pipe(
      Effect.annotateLogs({ event: "service.request_failed", service }),
      Effect.provide(OperationalLogger)
    )
  )
}
