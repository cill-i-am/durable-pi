import { Effect } from "effect"
import { expect, it, vi } from "vitest"

import { imageBytes, imageWorkspace } from "./image-fixture"

it("batches visible reply files with single-reader parity, order, deduplication and fresh visibility", async () => {
  const f = imageWorkspace()
  const files = Array.from({ length: 4 }, () => crypto.randomUUID())
  for (const [index, id] of files.entries())
    await Effect.runPromise(
      f.workspace.upload({
        id,
        name: `${index}.jpg`,
        mime: "image/jpeg",
        bytes: new Uint8Array([...imageBytes, index]),
      })
    )
  const ids = Array.from({ length: 100 }, (_, index) => `turn-${index}`)
  ids[99] = "turn-'quoted'"
  for (const turnId of ids)
    await Effect.runPromise(
      f.workspace.replyFile({
        operationId: `z:${turnId}`,
        turnId,
        fileId: files[0]!,
      })
    )
  for (const [operationId, fileId] of [
    ["a", files[3]!],
    ["b", files[0]!],
    ["c", files[1]!],
    ["d", files[2]!],
  ] as const)
    await Effect.runPromise(
      f.workspace.replyFile({ operationId, turnId: ids[0]!, fileId: fileId! })
    )
  await Effect.runPromise(
    f.workspace.replyFile({
      operationId: "outside",
      turnId: "outside",
      fileId: files[3]!,
    })
  )
  await Effect.runPromise(f.workspace.trash(files[1]!, true))
  f.db.run(
    "UPDATE workspace_files SET status='uploading' WHERE id=?",
    files[2]!
  )
  const expected = new Map(
    await Effect.runPromise(
      Effect.forEach(ids, (id) =>
        f.workspace
          .replyFiles(id)
          .pipe(Effect.map((rows) => [id, rows] as const))
      )
    )
  )
  const read = vi.spyOn(f.db, "use")
  const bulk = await Effect.runPromise(
    f.workspace.replyFilesForTurns([...ids, ids[0]!, "missing"])
  )
  expect(bulk).toEqual(expected)
  expect(bulk.get(ids[0]!)?.map((file) => file.id)).toEqual([
    files[3],
    files[0],
  ])
  expect(bulk.has("outside")).toBe(false)
  expect(bulk.has("missing")).toBe(false)
  // One reply lookup and one metadata read for each distinct linked file.
  expect(read).toHaveBeenCalledTimes(5)
  await Effect.runPromise(f.workspace.trash(files[0]!, true))
  const hidden = await Effect.runPromise(f.workspace.replyFilesForTurns(ids))
  expect(hidden.get(ids[0]!)?.map((file) => file.id)).toEqual([files[3]])
  expect(hidden.has(ids[1]!)).toBe(false)
  await Effect.runPromise(f.workspace.trash(files[0]!, false))
  expect(
    (await Effect.runPromise(f.workspace.replyFilesForTurns(ids)))
      .get(ids[1]!)
      ?.map((file) => file.id)
  ).toEqual([files[0]])
  read.mockClear()
  expect(
    (await Effect.runPromise(f.workspace.replyFilesForTurns([]))).size
  ).toBe(0)
  expect(read).not.toHaveBeenCalled()
})
