import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useFiles, uploadFile } from "@/features/files"
import { agentUrl, errorMessage } from "@/http/client"
import type { CommandRun } from "@/terminal/contracts"
import { exportPlan, MAX_TRANSFER_BYTES } from "@/terminal/transfers"

export function FileTransfers({
  agentId,
  busy,
  attempt,
  onImport,
  onExport,
  onRetry,
  onCancel,
}: {
  agentId: string
  busy: boolean
  attempt: boolean
  onImport: (id: string) => void
  onExport: (path: string) => void
  onRetry: () => void
  onCancel: () => void
}) {
  const files = useFiles(agentId)
  const [path, setPath] = useState("/workspace/result.txt")
  const [invalid, setInvalid] = useState(false)
  useEffect(() => {
    void files.refresh()
  }, [files.refresh])
  const available = files.files.filter(
    (file) => file.status === "ready" && !file.trashed
  )
  return (
    <section
      className="flex flex-col gap-4"
      aria-label="Terminal file transfers"
    >
      <p className="text-xs text-muted-foreground">
        Copy a private file into a new folder under /workspace/imports. Exports
        read the last saved checkpoint; save your shell first. Files must be
        non-empty and up to 8 MB.
      </p>
      {files.error && (
        <Alert>
          <AlertDescription>{files.error}</AlertDescription>
        </Alert>
      )}
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) void files.refresh()
        }}
      >
        <DropdownMenuTrigger
          render={
            <Button size="sm" variant="outline" disabled={busy || attempt} />
          }
        >
          <ArrowDownToLine data-icon="inline-start" /> Copy from Files
        </DropdownMenuTrigger>
        <DropdownMenuContent className="max-h-64 max-w-80 overflow-y-auto">
          <DropdownMenuGroup>
            {available.map((file) => (
              <DropdownMenuItem key={file.id} onClick={() => onImport(file.id)}>
                <span className="truncate">{file.name}</span>
              </DropdownMenuItem>
            ))}
            {!available.length && (
              <DropdownMenuItem disabled>
                {files.loading
                  ? "Loading files…"
                  : "Upload a file using Files first"}
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          try {
            exportPlan({ id: crypto.randomUUID(), path })
            setInvalid(false)
            onExport(path)
          } catch {
            setInvalid(true)
          }
        }}
      >
        <FieldGroup>
          <Field data-invalid={invalid}>
            <FieldLabel htmlFor="terminal-export-path">
              File to export
            </FieldLabel>
            <Input
              id="terminal-export-path"
              value={path}
              onChange={(event) => {
                setPath(event.target.value)
                setInvalid(false)
              }}
              maxLength={1024}
              disabled={busy || attempt}
              aria-invalid={invalid}
            />
            {invalid && (
              <p className="text-xs text-destructive">
                Use a file inside /workspace, with a name up to 180 characters
                and no leading or trailing spaces. Avoid . or .. segments.
              </p>
            )}
          </Field>
          <Button type="submit" size="sm" disabled={busy || attempt}>
            <ArrowUpFromLine data-icon="inline-start" /> Prepare export
          </Button>
        </FieldGroup>
      </form>
      {attempt && (
        <Alert>
          <AlertDescription>
            The request is unconfirmed. Retry keeps the same transfer ID.
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={onRetry}
            >
              Retry transfer
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={onCancel}
            >
              Cancel transfer request
            </Button>
          </AlertDescription>
        </Alert>
      )}
    </section>
  )
}

export function ExportedFile({
  agentId,
  run,
}: {
  agentId: string
  run: CommandRun
}) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("")
  const lock = useRef(false)
  const filename = run.transfer?.name
  if (
    run.transfer?.kind !== "export" ||
    run.status !== "succeeded" ||
    !filename
  )
    return null
  const save = async () => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setMessage("")
    try {
      const response = await fetch(
        agentUrl(agentId, `terminal/${encodeURIComponent(run.id)}/file`)
      )
      if (!response.ok) throw new Error(errorMessage(await response.json()))
      const blob = await response.blob()
      if (!blob.size || blob.size > MAX_TRANSFER_BYTES)
        throw new Error("The exported file is too large or empty.")
      const file = new File([blob], filename, { type: blob.type })
      await uploadFile(agentId, {
        id: run.id,
        file,
        status: "uploading",
        attach: false,
      })
      setMessage(
        "Saved to this bot’s Files. You can preview, download or attach it there."
      )
    } catch (cause) {
      setMessage(
        cause instanceof Error
          ? cause.message
          : "Could not save to Files. Retry the same export."
      )
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <a
        href={agentUrl(agentId, `terminal/${encodeURIComponent(run.id)}/file`)}
        download={filename}
        data-slot="button"
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        Download exported file
      </a>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void save()}
      >
        {busy ? "Preparing and saving…" : "Add exported file to Files"}
      </Button>
      {message && (
        <p className="text-xs text-muted-foreground" role="status">
          {message}
        </p>
      )}
    </div>
  )
}
