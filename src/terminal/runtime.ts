import type { Effect, Scope } from "effect"
import { Schema } from "effect"

import type { Checkpoint } from "./contracts"

export class TerminalRuntimeError extends Schema.TaggedError<TerminalRuntimeError>()(
  "TerminalRuntimeError",
  {
    operation: Schema.String,
    cause: Schema.Unknown,
  }
) {}
export type TerminalSocket = Pick<
  WebSocket,
  | "binaryType"
  | "readyState"
  | "send"
  | "close"
  | "addEventListener"
  | "removeEventListener"
>
export interface InteractiveConnection {
  /** Accept once while the scope still owns the socket. */
  readonly accept: () => TerminalSocket
  /** Called only after the session installed its relay/disconnect owner. */
  readonly transfer: () => void
}
export interface InteractiveRuntime {
  connect: (
    request: Request
  ) => Effect.Effect<InteractiveConnection, TerminalRuntimeError, Scope.Scope>
  close: () => Effect.Effect<void, TerminalRuntimeError>
  settle: () => Effect.Effect<void>
}
/** Cancellation stops the Effect continuation. settle additionally joins any
 * noncooperative foreign work before the workspace permit can be released. */
export interface TerminalRuntime {
  restore: (
    bytes: Uint8Array | null,
    signal: AbortSignal,
    unrestricted: boolean
  ) => Effect.Effect<void, TerminalRuntimeError>
  execute: (
    command: string,
    output: (text: string) => void,
    signal: AbortSignal
  ) => Effect.Effect<number, TerminalRuntimeError>
  snapshot: (
    signal: AbortSignal
  ) => Effect.Effect<Uint8Array, TerminalRuntimeError>
  importFile: (
    path: string,
    bytes: Uint8Array,
    signal: AbortSignal
  ) => Effect.Effect<void, TerminalRuntimeError>
  exportFile: (
    path: string,
    signal: AbortSignal
  ) => Effect.Effect<Uint8Array, TerminalRuntimeError>
  openInteractive: (
    signal: AbortSignal
  ) => Effect.Effect<InteractiveRuntime, TerminalRuntimeError>
  close: () => Effect.Effect<void, TerminalRuntimeError>
  settle: () => Effect.Effect<void>
}
export interface CheckpointStorage {
  read: (
    checkpoint: Checkpoint
  ) => Effect.Effect<Uint8Array, TerminalRuntimeError>
  write: (bytes: Uint8Array) => Effect.Effect<Checkpoint, TerminalRuntimeError>
  settle: () => Effect.Effect<void>
}
