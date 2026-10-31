import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { DataLoading } from "@workspace/ui/components/data-loading"
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { useFiles, uploadFile } from "@/features/files"
import { agentUrl, errorMessage } from "@/http/client"
import { nativeOperation } from "@/shared/interop"
import type { CommandRun } from "@/terminal/contracts"
import { exportPlan, MAX_TRANSFER_BYTES } from "@/terminal/transfers"

import { makeExportSaveOwner } from "./export-save"
import { exportSaveMachine } from "./export-save.machine"

export function FileTransfers({
  agentId,
  busy,
  attempt,
  onImport,
  onExport,
  onRetry,
  onCancel,
  active = true,
}: {
  active?: boolean
  agentId: string
  busy: boolean
  attempt: boolean
  onImport: (id: string) => void
  onExport: (path: string) => void
  onRetry: () => void
  onCancel: () => void
}) {
  const activeView = useRef(active)
  useLayoutEffect(() => {
    activeView.current = active
    return () => {
      activeView.current = false
    }
  }, [active])
  const files = useFiles(agentId)
  const { refresh } = files
  const [path, setPath] = useState("/workspace/result.txt")
  const [invalid, setInvalid] = useState(false)
  useEffect(() => {
    void refresh()
  }, [refresh])
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
        open={active ? undefined : false}
        onOpenChange={(open) => {
          if (open) void refresh()
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
          <DataLoading
            loading={files.loading && !files.files.length && !files.error}
            label="Loading files to copy"
          >
            <DropdownMenuGroup>
              {available.map((file) => (
                <DropdownMenuItem
                  key={file.id}
                  onClick={() => {
                    if (activeView.current) onImport(file.id)
                  }}
                >
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
          </DataLoading>
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
  const filename =
    run.transfer?.kind === "export" && run.status === "succeeded"
      ? run.transfer.name
      : undefined
  const [actor, setActor] = useState<EffectActor<
    ReturnType<typeof exportSaveMachine>
  > | null>(null)
  const [state, setState] = useState({
    identity: "",
    busy: false,
    saved: false,
    message: "",
  })
  const identity = JSON.stringify([agentId, run.id, filename])
  useEffect(() => {
    if (!filename) return
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const owner = yield* makeExportSaveOwner({
          download: nativeOperation(
            async (signal) => {
              const response = await fetch(
                agentUrl(
                  agentId,
                  `terminal/${encodeURIComponent(run.id)}/file`
                ),
                { signal }
              )
              if (!response.ok)
                throw new Error(errorMessage(await response.json()))
              const blob = await response.blob()
              if (!blob.size || blob.size > MAX_TRANSFER_BYTES)
                throw new Error("The exported file is too large or empty.")
              return new File([blob], filename, { type: blob.type })
            },
            (cause) => cause
          ),
          upload: (file) =>
            nativeOperation(
              () =>
                uploadFile(agentId, {
                  id: run.id,
                  file,
                  status: "uploading",
                  attach: false,
                }),
              (cause) => cause
            ),
        })
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            owner.subscribe((snapshot) => {
              if (mounted)
                setState({
                  identity,
                  busy:
                    snapshot.matches("downloading") ||
                    snapshot.matches("uploading"),
                  saved: snapshot.matches("saved"),
                  message: snapshot.context.message,
                })
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        if (mounted) {
          setActor(owner)
          setState({ identity, busy: false, saved: false, message: "" })
        }
        return yield* Effect.never
      }).pipe(Effect.scoped)
    )
    return () => {
      mounted = false
      Effect.runFork(
        Fiber.interrupt(fiber).pipe(
          Effect.andThen(Fiber.await(fiber)),
          Effect.flatMap((exit) =>
            Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
              ? Effect.logError(exit.cause)
              : Effect.void
          )
        )
      )
    }
  }, [agentId, run.id, filename, identity])
  if (!filename) return null
  const current = state.identity === identity
  const busy = !current || state.busy,
    message = current ? state.message : ""
  const save = () => {
    if (current && actor) Effect.runFork(send(actor, { type: "SAVE" }))
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
        disabled={busy || (current && state.saved)}
        onClick={save}
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
