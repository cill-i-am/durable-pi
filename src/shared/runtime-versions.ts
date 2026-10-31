import { Schema } from "effect"

export const runtimeLibraryVersion = "6.0.0-alpha.71/1.0.0-alpha.10" as const
export const nativePiVersion = "1.4.0" as const
export const nativeExecutionVersion = "pi-durable@1.4.0" as const

// Persisted application records retain their original version and identities.
// These upgrades preserve the v1 workflow and v2 record semantics.
export const StoredLibraryVersion = Schema.Literals([
  "6.0.0-alpha.68/1.0.0-alpha.8",
  runtimeLibraryVersion,
])
export const StoredPiVersion = Schema.Literals(["1.3.0", nativePiVersion])
export const StoredNativeExecutionVersion = Schema.Literals([
  "pi-durable@1.3.0",
  nativeExecutionVersion,
])
