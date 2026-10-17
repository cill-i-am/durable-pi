import { Effect, Schema } from "effect"

import { preserveFatal } from "../../shared/effect"
import { nativeBytes } from "../../shared/stream"
import type { CommandRun } from "../contracts"
import { WorkspaceImport, type WorkspaceImportError } from "../workspace-import"

class WorkspaceImportInvalid extends Schema.TaggedError<WorkspaceImportInvalid>()(
  "WorkspaceImportInvalid",
  {}
) {}
const failed = () =>
  Effect.succeed(
    Response.json(
      {
        error:
          "Could not copy this file. Check the bot, source file and terminal status, then retry the same transfer.",
      },
      { status: 409 }
    )
  )
export function importWorkspaceFile(
  copy: (
    input: WorkspaceImport
  ) => Effect.Effect<CommandRun, WorkspaceImportError>,
  request: Request
): Effect.Effect<Response> {
  const invalid = () => new WorkspaceImportInvalid()
  return Effect.gen(function* () {
    yield* Effect.yieldNow
    if (!request.body) return yield* invalid()
    const bytes = yield* nativeBytes(request.body, 2048, invalid, invalid)
    const input = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(WorkspaceImport)
    )(new TextDecoder().decode(bytes)).pipe(
      preserveFatal,
      Effect.mapError(invalid)
    )
    return Response.json(yield* copy(input), { status: 202 })
  }).pipe(
    Effect.scoped,
    preserveFatal,
    Effect.catchTags({
      WorkspaceImportInvalid: failed,
      TerminalFailure: failed,
      TerminalRuntimeError: failed,
      FileRejected: failed,
      FileNotFound: failed,
      WorkspaceReadOnly: failed,
      WorkspaceUnavailable: failed,
    })
  )
}
