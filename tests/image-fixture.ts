import { createHash } from "node:crypto"

import { Effect } from "effect"

import { r2WorkspaceAssets } from "../src/workspace/adapters/r2"
import { SqliteWorkspace } from "../src/workspace/adapters/sqlite"
import { WorkspaceUnavailable } from "../src/workspace/files"
import {
  makeWorkspace,
  type WorkspaceProcessing,
} from "../src/workspace/service"
import { database } from "./database"

export const imageBytes = new Uint8Array([255, 216, 255, 224, 0, 16])
export const imagePreview = new Uint8Array([255, 216, 255, 224])
export const imageMetadata = {
  id: "123456789",
  mime: "image/jpeg" as const,
  sha256: createHash("sha256").update(imageBytes).digest("base64"),
}
export function imageWorkspace(processing: Partial<WorkspaceProcessing> = {}) {
  const db = database(),
    objects = new Map<string, Uint8Array>()
  const calls = { prepared: 0, writes: 0 },
    state = { writable: true, failWrites: false }
  const assets = r2WorkspaceAssets(
    {
      put: async (key, bytes) => {
        calls.writes++
        if (state.failWrites) throw new Error("Synthetic storage failure")
        objects.set(key, bytes.slice())
      },
      get: async (key) => {
        const value = objects.get(key)
        return value
          ? {
              body: new Blob([new Uint8Array(value)]).stream(),
              arrayBuffer: async () => value.slice().buffer,
            }
          : null
      },
    },
    "owner/agent"
  )
  const workspace = makeWorkspace(
    new SqliteWorkspace(db),
    assets,
    () => Effect.succeed(state.writable),
    {
      document: () => Effect.fail(new WorkspaceUnavailable()),
      video: () => Effect.fail(new WorkspaceUnavailable()),
      image: () =>
        Effect.sync(() => {
          calls.prepared++
          return imagePreview
        }),
      ...processing,
    }
  )
  return { db, objects, calls, state, workspace }
}
