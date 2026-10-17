import { Plus, Upload, X } from "lucide-react"
import { useRef } from "react"

import { Button } from "@/components/ui/button"

import type { FilesState } from "./use-files"

export function FilePicker({
  state,
  attach = true,
  disabled = false,
}: {
  state: FilesState
  attach?: boolean
  disabled?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        aria-label="Choose files"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ""
          void state.upload(files, attach)
        }}
      />
      <Button
        type="button"
        variant={attach ? "ghost" : "outline"}
        size={attach ? "icon-sm" : "sm"}
        disabled={disabled || state.uploading}
        aria-label={attach ? "Attach files" : "Upload files"}
        onClick={() => input.current?.click()}
      >
        {attach ? (
          <Plus />
        ) : (
          <>
            <Upload />
            Upload
          </>
        )}
      </Button>
    </>
  )
}
export function UploadStatus({ state }: { state: FilesState }) {
  return (
    <div aria-live="polite" className="flex flex-col gap-2">
      {state.uploads.map((item) => (
        <div
          key={item.id}
          className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-xs"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{item.file.name}</p>
            <p className="text-muted-foreground">
              {item.status === "uploading"
                ? "Preparing and uploading…"
                : item.error}
            </p>
          </div>
          {item.status === "failed" && (
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={state.uploading}
                onClick={() => void state.retry(item)}
              >
                Retry
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Dismiss upload ${item.file.name}`}
                onClick={() => state.dismiss(item.id)}
              >
                <X />
              </Button>
            </>
          )}
        </div>
      ))}
    </div>
  )
}
