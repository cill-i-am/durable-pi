import { MAX_ATTACHMENTS, type FileInfo } from "@/workspace/files"

/** Pure file/selection data, scoped to one agent owner. Lifecycle actors are the
 * only asynchronous writers; a retired owner cannot reach a new owner's cache. */
export function makeFilesCache(initial: readonly FileInfo[]) {
  let value = {
    files: [] as readonly FileInfo[],
    selected: initial.slice(0, MAX_ATTACHMENTS) as readonly FileInfo[],
  }
  const listeners = new Set<() => void>()
  const update = (next: typeof value) => {
    value = next
    listeners.forEach((listener) => listener())
  }
  const select = (file: FileInfo) => {
    if (
      value.selected.length >= MAX_ATTACHMENTS ||
      value.selected.some((saved) => saved.id === file.id)
    )
      return
    update({ ...value, selected: [...value.selected, file] })
  }
  return {
    read: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    select,
    replace: (files: readonly FileInfo[]) =>
      update({
        files,
        selected: value.selected.map(
          (file) => files.find((saved) => saved.id === file.id) ?? file
        ),
      }),
    uploaded: (file: FileInfo, attach: boolean) => {
      update({
        ...value,
        files: [file, ...value.files.filter((saved) => saved.id !== file.id)],
      })
      if (attach) select(file)
    },
    updated: (file: FileInfo) =>
      update({
        files: value.files.map((saved) =>
          saved.id === file.id ? file : saved
        ),
        selected: value.selected.flatMap((saved) =>
          saved.id !== file.id ? [saved] : file.trashed ? [] : [file]
        ),
      }),
    remove: (ids: readonly string[]) =>
      update({
        ...value,
        selected: value.selected.filter((file) => !ids.includes(file.id)),
      }),
  }
}
