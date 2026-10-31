import { Button } from "@workspace/ui/components/button"
import { Plus, Upload, X } from "lucide-react"
import { useRef } from "react"

import type { FilesState } from "./use-files"

import "./files.css"

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
    <div aria-live="polite" className="file-uploads">
      {state.uploads.map((item) => (
        <div key={item.id} className="file-upload">
          <div className="min-w-0 flex-1">
            <p className="font-medium break-words">{item.file.name}</p>
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
