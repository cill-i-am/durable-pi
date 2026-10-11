import { Schema } from "effect"
import { VideoResult } from "@/workspace/video"
import { useEffect, useRef, useState } from "react"
import {
  Download,
  Files,
  Paperclip,
  Pencil,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import { agentApi, agentUrl } from "@/http/client"
import type { FileInfo } from "@/workspace/files"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldLabel } from "@/components/ui/field"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { attachmentReady, fileDescription, legacyPdf } from "./preparation"
import { fileSize } from "./file-attachments"
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
        className="sr-only"
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
        variant="ghost"
        size={attach ? "icon-sm" : "sm"}
        disabled={disabled || state.uploading}
        aria-label={attach ? "Attach files" : "Upload files"}
        onClick={() => input.current?.click()}
      >
        {attach ? (
          <Paperclip />
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
    <div aria-live="polite" className="space-y-2">
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
export function FilesPanel({
  state,
  selectionDisabled = false,
}: {
  state: FilesState
  selectionDisabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState("files")
  const [preview, setPreview] = useState<FileInfo | null>(null)
  const visible = state.files.filter(
    (file) => file.trashed === (tab === "trash")
  )
  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (value) void state.refresh()
      }}
    >
      <SheetTrigger
        render={<Button variant="ghost" size="sm" aria-label="Files" />}
      >
        <Files />
        <span className="chat-action-label hidden sm:inline">Files</span>
      </SheetTrigger>
      <SheetContent className="w-full gap-0 sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Bot files</SheetTitle>
          <SheetDescription>
            Private to this bot. Up to 8 MB per file.
          </SheetDescription>
        </SheetHeader>
        <div className="flex items-center justify-between gap-2 border-y px-4 py-2">
          <Tabs
            value={tab}
            onValueChange={(value) => {
              setTab(String(value))
              setPreview(null)
            }}
          >
            <TabsList>
              <TabsTrigger value="files">Files</TabsTrigger>
              <TabsTrigger value="trash">Trash</TabsTrigger>
            </TabsList>
          </Tabs>
          <FilePicker state={state} attach={false} />
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {state.error && (
            <Alert>
              <AlertDescription>
                {state.error}
                <Button
                  variant="link"
                  size="xs"
                  onClick={() => void state.refresh()}
                >
                  Reload
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <UploadStatus state={state} />
          {state.loading && (
            <p className="text-sm text-muted-foreground">Loading files…</p>
          )}
          {!state.loading && !visible.length && (
            <div className="py-12 text-center">
              <Files className="mx-auto mb-3 text-muted-foreground" />
              <p className="font-medium">
                {tab === "trash" ? "Trash is empty" : "A place for the context"}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {tab === "trash"
                  ? "Removed files can be restored here."
                  : "Upload images, notes, documents, or a video. Attach up to four files to a message."}
              </p>
            </div>
          )}
          <div className="divide-y">
            {visible.map((file) => (
              <FileRow
                key={file.id}
                file={file}
                state={state}
                onPreview={() =>
                  setPreview((current) =>
                    current?.id === file.id ? null : file
                  )
                }
                onAttach={() => {
                  state.select(file)
                  setOpen(false)
                }}
                disabled={
                  !attachmentReady(file) ||
                  selectionDisabled ||
                  state.selected.length >= 4 ||
                  state.selected.some((item) => item.id === file.id)
                }
              />
            ))}
          </div>
          {preview &&
            state.files.some(
              (file) => file.id === preview.id && !file.trashed
            ) && (
              <FilePreview
                key={preview.id}
                file={preview}
                agentId={state.agentId}
              />
            )}
        </div>
        <div className="border-t p-4 text-xs text-muted-foreground">
          Images, text, readable PDFs and prepared video frames can be used by
          the bot. PDFs: up to 50 pages; no OCR. Videos: up to ten minutes, six
          sampled frames and embedded text captions. Audio is not transcribed.
        </div>
      </SheetContent>
    </Sheet>
  )
}
function FileRow({
  file,
  state,
  onAttach,
  onPreview,
  disabled,
}: {
  file: FileInfo
  state: FilesState
  onAttach: () => void
  onPreview: () => void
  disabled: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(file.name)
  const [busy, setBusy] = useState(false)
  async function mutate(action: "trash" | "restore" | "rename" | "extract") {
    setBusy(true)
    try {
      if (await state.mutate(file.id, action, name.trim())) setEditing(false)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="py-3">
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault()
            void mutate("rename")
          }}
        >
          <Field>
            <FieldLabel htmlFor={`name-${file.id}`}>File name</FieldLabel>
            <Input
              id={`name-${file.id}`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={180}
              required
            />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" size="xs" disabled={busy}>
              Save
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex min-w-0 items-center gap-3">
            {file.kind === "image" &&
            !file.trashed &&
            file.status === "ready" ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Preview ${file.name}`}
                onClick={onPreview}
              >
                <img
                  className="size-9 rounded-md object-cover"
                  src={agentUrl(state.agentId, `files/${file.id}/vision`)}
                  alt=""
                />
              </Button>
            ) : (
              <Files className="size-5 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium" title={file.name}>
                {file.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {fileSize(file.size)} ·{" "}
                {file.status === "uploading"
                  ? "Upload incomplete · reselect the original file to retry"
                  : fileDescription(file)}
              </p>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap justify-end gap-1">
            {file.trashed ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => void mutate("restore")}
              >
                <RotateCcw />
                Restore
              </Button>
            ) : (
              <>
                {file.status === "ready" && (
                  <>
                    {(file.extraction?.status === "failed" ||
                      file.extraction?.status === "empty" ||
                      legacyPdf(file) ||
                      (file.kind === "video" &&
                        (!file.video || file.video.status === "failed"))) && (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void mutate("extract")}
                      >
                        {file.kind === "video"
                          ? "Prepare frames"
                          : legacyPdf(file)
                            ? "Extract text"
                            : "Retry extraction"}
                      </Button>
                    )}
                    {(file.kind === "text" ||
                      file.extraction?.status === "ready" ||
                      file.video?.status === "ready") && (
                      <Button size="xs" variant="ghost" onClick={onPreview}>
                        Preview
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={disabled}
                      onClick={onAttach}
                    >
                      <Paperclip />
                      Attach
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Download ${file.name}`}
                      render={
                        <a
                          href={
                            agentUrl(
                              state.agentId,
                              `files/${file.id}/content`
                            ) + "&download=1"
                          }
                          download
                        />
                      }
                    >
                      <Download />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Rename ${file.name}`}
                      onClick={() => {
                        setName(file.name)
                        setEditing(true)
                      }}
                    >
                      <Pencil />
                    </Button>
                  </>
                )}
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Move ${file.name} to Trash`}
                  onClick={() => void mutate("trash")}
                >
                  <Trash2 />
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function FilePreview({ file, agentId }: { file: FileInfo; agentId: string }) {
  const [text, setText] = useState("")
  const [error, setError] = useState("")
  useEffect(() => {
    if (file.kind !== "text" && file.extraction?.status !== "ready") return
    const controller = new AbortController()
    void agentApi(agentId)<{ text: string; next: number | null }>(
      `files/${file.id}/text`,
      undefined,
      controller.signal
    )
      .then((result) => {
        setText(
          result.text +
            (result.next === null
              ? ""
              : "\n… Preview truncated. Download the original for the full file.")
        )
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Could not open this preview.")
      })
    return () => controller.abort()
  }, [agentId, file.id, file.kind, file.extraction?.status])
  if (file.kind === "video")
    return <VideoPreview file={file} agentId={agentId} />
  return (
    <figure className="rounded-lg border p-3">
      <figcaption className="mb-2 truncate text-xs font-medium">
        {file.name}
      </figcaption>
      {file.kind === "image" ? (
        <img
          className="max-h-80 w-full rounded-md object-contain"
          src={agentUrl(agentId, `files/${file.id}/content`)}
          alt={file.name}
        />
      ) : (
        <pre className="max-h-80 overflow-auto text-xs break-all whitespace-pre-wrap">
          {error || text || "Loading…"}
        </pre>
      )}
    </figure>
  )
}

function VideoPreview({ file, agentId }: { file: FileInfo; agentId: string }) {
  const [video, setVideo] = useState<VideoResult | null>(null),
    [error, setError] = useState("")
  useEffect(() => {
    const controller = new AbortController()
    void agentApi(agentId)(
      `files/${file.id}/video`,
      undefined,
      controller.signal
    )
      .then((value) => {
        if (!controller.signal.aborted)
          setVideo(Schema.decodeUnknownSync(VideoResult)(value))
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            "Could not load these frames. Close the preview and try again."
          )
      })
    return () => controller.abort()
  }, [agentId, file.id])
  return (
    <figure className="space-y-3 rounded-lg border p-3">
      <figcaption className="text-sm font-medium break-words">
        {file.name}
      </figcaption>
      <p className="text-xs text-muted-foreground">
        Sampled frames omit movement and events between them. Audio has not been
        transcribed.
      </p>
      {!video ? (
        <p className="text-xs" role="status">
          {error || "Loading frames…"}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            {video.frames.map((frame, index) => (
              <figure key={index} className="space-y-1">
                <img
                  loading="lazy"
                  className="aspect-video w-full rounded-md bg-muted object-contain"
                  src={`data:image/jpeg;base64,${frame.jpeg}`}
                  alt={`Frame at ${frame.at.toFixed(2)} seconds`}
                />
                <figcaption className="text-xs text-muted-foreground">
                  {frame.at.toFixed(2)}s
                </figcaption>
              </figure>
            ))}
          </div>
          {video.captions ? (
            <details>
              <summary className="cursor-pointer text-xs font-medium">
                Embedded captions{video.captionsTruncated ? " · truncated" : ""}
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto text-xs break-words whitespace-pre-wrap">
                {video.captions}
              </pre>
            </details>
          ) : (
            <p className="text-xs text-muted-foreground">
              No embedded text captions were available.
            </p>
          )}
        </>
      )}
    </figure>
  )
}
