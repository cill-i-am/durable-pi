import type { Effect, Scope, Stream } from "effect"

import type { WorkspaceUnavailable } from "./files"

export interface WorkspaceAsset {
  readonly id: string
  readonly hash: string
  readonly variant?: "pdf-text-v1" | "video-v1"
}
export interface WorkspaceAssets {
  read: (
    asset: WorkspaceAsset
  ) => Effect.Effect<Uint8Array, WorkspaceUnavailable>
  open: (
    asset: WorkspaceAsset
  ) => Effect.Effect<
    Stream.Stream<Uint8Array, WorkspaceUnavailable>,
    WorkspaceUnavailable,
    Scope.Scope
  >
  write: (
    asset: WorkspaceAsset,
    bytes: Uint8Array
  ) => Effect.Effect<void, WorkspaceUnavailable>
  digest: (bytes: Uint8Array) => Effect.Effect<string, WorkspaceUnavailable>
}
