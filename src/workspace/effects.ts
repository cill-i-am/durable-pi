import { Schema, Effect } from "effect"
import {
  FileNotFound,
  FileRejected,
  WorkspaceReadOnly,
  WorkspaceUnavailable,
} from "./files"

/** Translate checked synchronous decisions/ledger failures; preserve defects. */
export const workspaceOperation = <T>(body: () => T) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const knownFailure = Schema.decodeUnknownOption(
        Schema.Union([
          FileNotFound,
          FileRejected,
          WorkspaceReadOnly,
          WorkspaceUnavailable,
        ])
      )(cause)
      if (knownFailure._tag === "Some") return knownFailure.value
      throw cause
    },
  })
