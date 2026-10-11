import { Markdown } from "@/components/markdown"
import { Schema } from "effect"
import { VideoResult } from "@/workspace/video"
import { useEffect, useRef, useState } from "react"
import {
  Download,
  Ellipsis,
  Files,
  FileText,
  Image,
  Video,
  Plus,
  Pencil,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import { agentApi, agentUrl } from "@/http/client"
import type { FileInfo } from "@/workspace/files"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldLabel } from "@/components/ui/field"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
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
export function FilesWorkbench({
  state,
  selectionDisabled = false,
  onAttached,
}: {
  state: FilesState
  selectionDisabled?: boolean
  onAttached: () => void
}) {
  const [tab, setTab] = useState("files")
  const refresh = state.refresh
  useEffect(() => {
    void refresh()
  }, [refresh])
  const [previewId, setPreviewId] = useState<string | null>(null)
  const visible = state.files.filter(
    (file) => file.trashed === (tab === "trash")
  )
  const preview = visible.find((file) => file.id === previewId) ?? visible[0]
  const selectedId = preview?.id ?? null
  useEffect(() => {
    // Pin the initial selection so a completed upload cannot replace an open draft.
    setPreviewId(selectedId)
  }, [selectedId])
  return (
    <>
      <header className="workbench-heading-row">
        <h2 className="workbench-section-title">Files</h2>
        <FilePicker state={state} attach={false} />
      </header>
      <div className="workbench-filter-row">
        <Tabs
          value={tab}
          onValueChange={(value) => {
            setTab(String(value))
            setPreviewId(null)
          }}
        >
          <TabsList variant="line">
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="trash">Trash</TabsTrigger>
          </TabsList>
        </Tabs>
        <span className="text-xs text-muted-foreground">
          {visible.length} {visible.length === 1 ? "file" : "files"} · Private
        </span>
      </div>
      <div className="workbench-body">
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
        {!!state.uploads.length && <UploadStatus state={state} />}
        {state.loading && (
          <p className="text-sm text-muted-foreground">Loading files…</p>
        )}
        {!state.loading && !visible.length && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>
                {tab === "trash" ? "Trash is empty" : "A place for the context"}
              </EmptyTitle>
              <EmptyDescription>
                {tab === "trash"
                  ? "Removed files can be restored here."
                  : "Upload images, notes, documents, or a video. Attach up to four files to a message."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {!!visible.length && (
          <div className="file-explorer">
            <nav className="file-explorer-list" aria-label="Agent files">
              {visible.map((file) => {
                const Icon =
                  file.kind === "image"
                    ? Image
                    : file.kind === "video"
                      ? Video
                      : FileText
                return (
                  <Button
                    key={file.id}
                    variant={preview?.id === file.id ? "secondary" : "ghost"}
                    aria-pressed={preview?.id === file.id}
                    onClick={() => setPreviewId(file.id)}
                    title={file.name}
                  >
                    <Icon data-icon="inline-start" />
                    <span className="truncate">{file.name}</span>
                  </Button>
                )
              })}
            </nav>
            {preview && (
              <section
                className="file-explorer-detail"
                aria-label={`Details for ${preview.name}`}
              >
                <FileDetails
                  key={`details-${preview.id}`}
                  file={preview}
                  state={state}
                  onAttach={() => {
                    state.select(preview)
                    onAttached()
                  }}
                  disabled={
                    !attachmentReady(preview) ||
                    selectionDisabled ||
                    state.selected.length >= 4 ||
                    state.selected.some((item) => item.id === preview.id)
                  }
                />
                {!preview.trashed && preview.status === "ready" && (
                  <FilePreview
                    key={`preview-${preview.id}`}
                    file={preview}
                    agentId={state.agentId}
                  />
                )}
              </section>
            )}
          </div>
        )}
      </div>
      <footer className="text-xs text-muted-foreground">
        <details>
          <summary className="cursor-pointer">
            Private files · Supported formats and limits
          </summary>
          <p className="mt-2">
            Up to 8 MB per file. Images, text, readable PDFs (50 pages; no OCR),
            and video frames with embedded text captions. Videos: up to ten
            minutes and six sampled frames. Audio is not transcribed.
          </p>
        </details>
      </footer>
    </>
  )
}
function FileDetails({
  file,
  state,
  onAttach,
  disabled,
}: {
  file: FileInfo
  state: FilesState
  onAttach: () => void
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
          className="flex flex-col gap-2"
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
        <div className="file-detail-heading">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Files className="size-5 shrink-0 text-muted-foreground" />
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
          <div className="flex shrink-0 items-center justify-end gap-1">
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
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={disabled}
                      onClick={onAttach}
                    >
                      <Plus />
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
                  </>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger
                    disabled={busy}
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Options for ${file.name}`}
                      />
                    }
                  >
                    <Ellipsis />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-40">
                    {file.status === "ready" && (
                      <DropdownMenuItem
                        onClick={() => {
                          setName(file.name)
                          setEditing(true)
                        }}
                      >
                        <Pencil /> Rename
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={() => void mutate("trash")}>
                      <Trash2 /> Move to Trash
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function FilePreview({ file, agentId }: { file: FileInfo; agentId: string }) {
  const [text, setText] = useState("")
  const [error, setError] = useState("")
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    if (file.kind !== "text" && file.extraction?.status !== "ready") return
    const controller = new AbortController()
    void agentApi(agentId)<{ text: string; next: number | null }>(
      `files/${file.id}/text`,
      undefined,
      controller.signal
    )
      .then((result) => {
        if (controller.signal.aborted) return
        setLoaded(true)
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
  if (file.kind === "video" && file.video?.status === "ready")
    return <VideoPreview file={file} agentId={agentId} />
  if (
    file.kind !== "image" &&
    file.kind !== "text" &&
    file.extraction?.status !== "ready"
  )
    return (
      <p className="text-xs text-muted-foreground">
        {fileDescription(file)}. Download the original to inspect it.
      </p>
    )
  return (
    <figure className="file-preview">
      <figcaption className="sr-only">Preview of {file.name}</figcaption>
      {file.kind === "image" ? (
        <img
          className="max-h-80 w-full rounded-md object-contain"
          src={agentUrl(agentId, `files/${file.id}/content`)}
          alt={file.name}
        />
      ) : /\.md(?:own)?$/i.test(file.name) && loaded && !error ? (
        <Tabs defaultValue="preview" className="file-text-preview">
          <TabsList variant="line" aria-label="File view">
            <TabsTrigger value="preview">Preview</TabsTrigger>
            <TabsTrigger value="source">Source</TabsTrigger>
          </TabsList>
          <TabsContent value="preview">
            <Markdown text={text} />
          </TabsContent>
          <TabsContent value="source">
            <pre className="text-xs break-words whitespace-pre-wrap">
              {text}
            </pre>
          </TabsContent>
        </Tabs>
      ) : (
        <pre className="max-h-80 overflow-auto text-xs break-words whitespace-pre-wrap">
          {error ||
            text ||
            (loaded ? "No readable text in this file." : "Loading…")}
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
    <figure className="flex flex-col gap-3">
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
              <figure key={index} className="flex flex-col gap-1">
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
