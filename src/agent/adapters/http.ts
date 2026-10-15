import { Effect, Schema } from "effect"
import { jsonRequest } from "../../shared/http"
import { preserveFatal } from "../../shared/effect"
import { nativeOperation } from "../../shared/interop"
import { DelegationFailure } from "../../delegation/contracts"
import { ModelUnavailable } from "../../inference/policy"
import { UsageStorageError } from "../../inference/usage-domain"
import {
  FileNotFound,
  FileRejected,
  WorkspaceReadOnly,
  WorkspaceUnavailable,
} from "../../workspace/files"
import {
  ConversationConflict,
  ConversationFull,
  ConversationStorageError,
} from "../../conversations/turns"
import {
  InvalidMemory,
  MemoryNotReady,
  MemoryStorageError,
} from "../../memory/domain"
import { MemorySchedulingError } from "../../memory/application"
import {
  AgentConflict,
  AgentStorageError,
  AgentNotFound,
} from "../../agents/domain"
import { SummaryFailure } from "../../memory/summary-model"
import { ConversationExecutionError } from "../../conversations/execution"
import { SkillConflict, SkillStorageError } from "../../skills/contracts"
import {
  ConnectionError,
  ConnectionStorageError,
} from "../../access/connections"
import {
  AccessConflict,
  AccessDenied,
  AccessStorageError,
} from "../../access/contracts"

export class AgentRequestInvalid extends Schema.TaggedError<AgentRequestInvalid>()(
  "AgentRequestInvalid",
  {}
) {}
export class AgentRequestUnavailable extends Schema.TaggedError<AgentRequestUnavailable>()(
  "AgentRequestUnavailable",
  { operation: Schema.String }
) {}
const HttpFailure = Schema.Union([
  AgentRequestInvalid,
  AgentConflict,
  AgentStorageError,
  AgentNotFound,
  SkillConflict,
  SkillStorageError,
  ConnectionError,
  ConnectionStorageError,
  AccessConflict,
  AccessDenied,
  AccessStorageError,
  AgentRequestUnavailable,
  DelegationFailure,
  ModelUnavailable,
  FileNotFound,
  FileRejected,
  WorkspaceReadOnly,
  WorkspaceUnavailable,
  ConversationConflict,
  ConversationFull,
  ConversationStorageError,
  ConversationExecutionError,
  InvalidMemory,
  MemoryNotReady,
  MemoryStorageError,
  MemorySchedulingError,
  SummaryFailure,
  UsageStorageError,
])

export const agentJson = <T>(
  request: Request,
  schema: Schema.Codec<T, unknown>,
  maximum = 140_000
) => jsonRequest(request, schema, maximum, () => new AgentRequestInvalid())

export const agentNative = <T>(
  operation: string,
  start: (signal: AbortSignal) => Promise<T>
) =>
  nativeOperation(start, (cause, channel) => {
    if (channel === "failure" || Schema.isSchemaError(cause)) throw cause
    return new AgentRequestUnavailable({ operation })
  })

const response = (error: typeof HttpFailure.Type): Response => {
  switch (error._tag) {
    case "DelegationFailure":
      return Response.json(
        { error: error.message, code: error.code },
        {
          status:
            error.code === "not_found"
              ? 404
              : error.code === "conflict"
                ? 409
                : error.code === "unavailable"
                  ? 503
                  : 400,
        }
      )
    case "ModelUnavailable":
      return Response.json(
        { error: error.message, code: "model_unavailable" },
        { status: 409 }
      )
    case "WorkspaceUnavailable":
      return Response.json(
        {
          error:
            "File storage is temporarily unavailable. Retry the same message.",
        },
        { status: 503 }
      )
    case "FileRejected":
      return Response.json({ error: error.message }, { status: 400 })
    case "FileNotFound":
      return Response.json(
        {
          error:
            "One of the attached files is no longer available. Restore it or remove the attachment.",
        },
        { status: 404 }
      )
    case "WorkspaceReadOnly":
      return Response.json(
        { error: "Restore this agent before changing its files." },
        { status: 409 }
      )
    case "ConversationConflict":
      return Response.json({ error: error.message }, { status: 409 })
    case "ConversationFull":
      return Response.json(
        { error: "Wait for the queued messages to finish." },
        { status: 429 }
      )
    case "AgentRequestUnavailable":
      return Response.json(
        {
          error:
            "The request could not be confirmed. Retry the same operation.",
        },
        { status: 503 }
      )
    case "AgentStorageError":
    case "AgentNotFound":
    case "SkillConflict":
    case "SkillStorageError":
    case "ConnectionError":
    case "ConnectionStorageError":
    case "AccessConflict":
    case "AccessDenied":
    case "AccessStorageError":
    case "ConversationStorageError":
    case "ConversationExecutionError":
    case "MemoryStorageError":
    case "MemorySchedulingError":
    case "UsageStorageError":
    case "AgentConflict":
    case "AgentRequestInvalid":
    case "InvalidMemory":
    case "MemoryNotReady":
    case "SummaryFailure":
      return Response.json(
        {
          error:
            "The request could not be completed. Your saved messages are safe.",
        },
        { status: 400 }
      )
  }
}

/** Only declared failures become normal HTTP responses. A tagged defect and a
 * compound Cause containing interruption must not become a validation result. */
export const agentResponse = <TRequirements>(
  program: Effect.Effect<Response, typeof HttpFailure.Type, TRequirements>
) =>
  program.pipe(
    preserveFatal,
    Effect.catch((cause) => {
      const decoded = Schema.decodeUnknownOption(HttpFailure)(cause)
      return decoded._tag === "Some"
        ? Effect.sync(() => response(decoded.value))
        : Effect.die(cause)
    })
  )
