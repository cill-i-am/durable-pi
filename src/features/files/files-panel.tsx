import { Link } from "@tanstack/react-router"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { DataLoading } from "@workspace/ui/components/data-loading"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@workspace/ui/components/empty"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@workspace/ui/components/tabs"
import {
  Plus,
  ChevronDown,
  Download,
  Ellipsis,
  Files,
  FileText,
  Image,
  Video,
  Pencil,
  RotateCcw,
  Trash2,
  ArrowLeft,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Markdown } from "@/components/markdown"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"
import { agentUrl } from "@/http/client"
import { parseAgentId, workspaceDestination } from "@/navigation/workspace"
import type { FileInfo } from "@/workspace/files"

import { AudioPlayer } from "./audio-player"
import { fileSize } from "./file-attachments"
import { attachmentSelectable, fileDescription, legacyPdf } from "./preparation"
import { FilePicker, UploadStatus } from "./upload-controls"
import { useFileDetails } from "./use-file-details"
import { useFilePreview } from "./use-file-preview"
import type { FilesState } from "./use-files"

import "./files.css"

export { FilePicker, UploadStatus } from "./upload-controls"
export function FilesWorkbench({
  state,
  selectionDisabled = false,
  onAttached,
  selected: previewId,
  onSelect,
  collection: tab,
  previewView,
  onPreviewViewChange,
  onCollectionChange,
  onPendingChange,
  active = true,
}: {
  selected: string | null
  onSelect: (id: string | null) => void
  onPendingChange: (pending: boolean) => void
  active?: boolean
  previewView: "preview" | "source"
  onPreviewViewChange: (view: "preview" | "source") => void
  collection: "files" | "trash"
  onCollectionChange: (collection: "files" | "trash") => void
  state: FilesState
  selectionDisabled?: boolean
  onAttached: () => void
}) {
  const [detailLocked, setDetailLocked] = useState(false)
  useEffect(() => {
    onPendingChange(detailLocked || state.uploading)
    return () => onPendingChange(false)
  }, [detailLocked, state.uploading, onPendingChange])
  const refresh = state.refresh
  useEffect(() => {
    void refresh()
  }, [refresh])
  const visible = state.files.filter(
    (file) => file.trashed === (tab === "trash")
  )
  const preview = visible.find((file) => file.id === previewId)
  return (
    <section className="files-surface">
      <header className="workbench-heading-row">
        <FileCollectionMenu
          active={active}
          tab={tab}
          locked={detailLocked}
          onCollectionChange={onCollectionChange}
        />
        <FilePicker state={state} attach={false} disabled={detailLocked} />
      </header>
      <div className="workbench-body files-workbench-body">
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
        {!state.loading && previewId && !preview && (
          <Alert>
            <AlertDescription>
              This file is unavailable in this collection.
            </AlertDescription>
          </Alert>
        )}
        <FileCollectionStatus
          state={state}
          collection={tab}
          visible={visible.length}
        />
        {!!visible.length && (
          <div className="file-explorer" data-selected={!!preview}>
            <nav className="file-explorer-list" aria-label="Agent files">
              <span className="file-list-caption">
                {visible.length} {visible.length === 1 ? "file" : "files"}
              </span>
              {visible.map((file) => {
                const Icon =
                  file.kind === "image"
                    ? Image
                    : file.kind === "video"
                      ? Video
                      : FileText
                return (
                  <Link
                    {...workspaceDestination(parseAgentId(state.agentId), {
                      panel: "files",
                      item: file.id,
                      tab,
                    })}
                    data-slot="button"
                    className={buttonVariants({
                      variant: preview?.id === file.id ? "secondary" : "ghost",
                    })}
                    key={file.id}
                    title={file.name}
                    aria-current={preview?.id === file.id ? "page" : undefined}
                    disabled={detailLocked}
                  >
                    <Icon data-icon="inline-start" />
                    <span className="file-row-name">{file.name}</span>
                  </Link>
                )
              })}
            </nav>
            {preview ? (
              <section
                className="file-explorer-detail"
                aria-label={`Details for ${preview.name}`}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  className="file-back"
                  disabled={detailLocked}
                  onClick={() => onSelect(null)}
                >
                  <ArrowLeft /> All files
                </Button>
                <FileDetails
                  key={`details-${state.agentId}-${preview.id}`}
                  file={preview}
                  active={active}
                  onPendingChange={setDetailLocked}
                  state={state}
                  onAttach={() => {
                    state.select(preview)
                    onAttached()
                  }}
                  disabled={
                    !attachmentSelectable(preview) ||
                    selectionDisabled ||
                    state.selected.length >= 4 ||
                    state.selected.some((item) => item.id === preview.id)
                  }
                />
                {!preview.trashed && preview.status === "ready" && (
                  <FilePreview
                    key={`preview-${state.agentId}-${preview.id}`}
                    file={preview}
                    agentId={state.agentId}
                    view={previewView}
                    onViewChange={onPreviewViewChange}
                  />
                )}
              </section>
            ) : (
              <Empty className="file-explorer-detail">
                <EmptyHeader>
                  <EmptyTitle>Select a file</EmptyTitle>
                  <EmptyDescription>
                    Choose a file to preview it or attach it to your message.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
        )}
      </div>
      <footer className="files-formats text-xs text-muted-foreground">
        <details>
          <summary className="cursor-pointer">
            Supported formats and limits
          </summary>
          <p className="mt-2">
            Up to 8 MB per file. Images, text, readable PDFs (50 pages; no OCR),
            and video frames with embedded text captions. Videos: up to ten
            minutes and six sampled frames. Audio is not transcribed.
          </p>
        </details>
      </footer>
    </section>
  )
}
function FileCollectionMenu({
  active,
  tab,
  locked,
  onCollectionChange,
}: {
  active: boolean
  tab: "files" | "trash"
  locked: boolean
  onCollectionChange: (tab: "files" | "trash") => void
}) {
  return (
    <DropdownMenu key={active ? "active" : "inactive"}>
      <DropdownMenuTrigger
        render={<Button variant="ghost" className="workbench-title-menu" />}
        disabled={locked}
        aria-label="File collection"
      >
        <h2 className="workbench-section-title">
          {tab === "trash" ? "Trash" : "Files"}
        </h2>
        <ChevronDown />
      </DropdownMenuTrigger>
      {active && (
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => onCollectionChange("files")}>
            <Files /> Files
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onCollectionChange("trash")}>
            <Trash2 /> Trash
          </DropdownMenuItem>
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  )
}
function FileDetails({
  onPendingChange,
  file,
  state,
  onAttach,
  disabled,
  active,
}: {
  onPendingChange: (pending: boolean) => void
  file: FileInfo
  state: FilesState
  onAttach: () => void
  disabled: boolean
  active: boolean
}) {
  const detail = useFileDetails(file.name, (action, name) =>
    state.mutate(file.id, action, name)
  )
  const { editing, busy, name } = detail
  const optionsTrigger = useRef<HTMLButtonElement>(null)
  const wasEditing = useRef(false)
  useEffect(() => {
    if (wasEditing.current && !editing) optionsTrigger.current?.focus()
    wasEditing.current = editing
  }, [editing])
  useEffect(() => {
    onPendingChange(!!editing || busy)
    return () => onPendingChange(false)
  }, [editing, busy, onPendingChange])
  const mutate = detail.submit
  return (
    <div className="file-detail-controls">
      {detail.failed && (
        <p role="alert" className="text-xs text-destructive">
          Could not update this file. Reload and try again.
        </p>
      )}
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
              autoFocus
              value={name}
              onChange={(event) => detail.change(event.target.value)}
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
              onClick={detail.cancel}
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
              <p className="file-detail-name font-medium">{file.name}</p>
              <p className="text-xs text-muted-foreground">
                {fileSize(file.size)} ·{" "}
                {file.status === "uploading"
                  ? "Upload incomplete · reselect the original file to retry"
                  : fileDescription(file)}
              </p>
            </div>
          </div>
          <div className="file-detail-actions">
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
                    <a
                      href={
                        agentUrl(state.agentId, `files/${file.id}/content`) +
                        "&download=1"
                      }
                      download
                      aria-label={`Download ${file.name}`}
                      className={buttonVariants({
                        size: "icon-xs",
                        variant: "ghost",
                      })}
                    >
                      <Download />
                    </a>
                  </>
                )}
                <DropdownMenu key={active ? "active" : "inactive"}>
                  <DropdownMenuTrigger
                    disabled={busy}
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        ref={optionsTrigger}
                        aria-label={`Options for ${file.name}`}
                      />
                    }
                  >
                    <Ellipsis />
                  </DropdownMenuTrigger>
                  {active && (
                    <DropdownMenuContent align="end" className="min-w-40">
                      {file.status === "ready" && (
                        <DropdownMenuItem
                          onClick={() => {
                            detail.edit()
                          }}
                        >
                          <Pencil /> Rename
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onClick={() => void mutate("trash")}>
                        <Trash2 /> Move to Trash
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  )}
                </DropdownMenu>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const readablePreview = (file: FileInfo) =>
  file.kind !== "audio" &&
  file.kind !== "video" &&
  (file.kind === "text" || file.extraction?.status === "ready")

function FilePreview({
  file,
  agentId,
  view,
  onViewChange,
}: {
  file: FileInfo
  agentId: string
  view: "preview" | "source"
  onViewChange: (view: "preview" | "source") => void
}) {
  const readable = readablePreview(file)
  const resource = useFilePreview({
    key: `${agentId}:${file.id}:${readable}`,
    agentId,
    fileId: file.id,
    kind: "text",
    eager: readable,
  })
  const text =
    resource.value && "text" in resource.value ? resource.value.text : ""
  const error = resource.failed ? "Could not open this preview." : ""
  const loaded = resource.loaded
  if (resource.failed)
    return (
      <Alert appearance="panel">
        <AlertDescription className="flex flex-col gap-3">
          <p>{error}</p>
          <Button
            className="self-start"
            variant="outline"
            size="sm"
            onClick={() => resource.toggle(true)}
          >
            Retry preview
          </Button>
        </AlertDescription>
      </Alert>
    )
  if (file.kind === "video" && file.video?.status === "ready")
    return <VideoPreview file={file} agentId={agentId} />
  if (file.kind === "audio")
    return (
      <AudioPlayer
        key={`${agentId}:${file.id}`}
        file={file}
        agentId={agentId}
      />
    )
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
      <DataLoading
        loading={file.kind !== "image" && !loaded}
        label="Loading file preview"
        layout="code"
      >
        {file.kind === "image" ? (
          <img
            className="max-h-80 w-full rounded-md object-contain"
            src={agentUrl(agentId, `files/${file.id}/content`)}
            alt={file.name}
          />
        ) : /\.md(?:own)?$/i.test(file.name) && loaded && !error ? (
          <Tabs
            value={view}
            onValueChange={(value: unknown) => {
              if (value === "preview" || value === "source") onViewChange(value)
            }}
            className="file-text-preview"
          >
            <TabsList aria-label="File view">
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
            {error || text || "No readable text in this file."}
          </pre>
        )}
      </DataLoading>
    </figure>
  )
}

function VideoPreview({ file, agentId }: { file: FileInfo; agentId: string }) {
  const resource = useFilePreview({
    key: `${agentId}:${file.id}`,
    agentId,
    fileId: file.id,
    kind: "video",
    eager: true,
  })
  const video =
    resource.value && "frames" in resource.value ? resource.value : null
  const error = resource.failed
    ? "Could not load these frames. Close the preview and try again."
    : ""
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
        error ? (
          <p className="text-xs" role="alert">
            {error}
          </p>
        ) : (
          <DataLoading loading label="Loading video frames" layout="media" />
        )
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

function EmptyFileCollection({
  collection,
}: {
  collection: "files" | "trash"
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>
          {collection === "trash" ? "Trash is empty" : "No files yet"}
        </EmptyTitle>
        <EmptyDescription>
          {collection === "trash"
            ? "Removed files can be restored here."
            : "Upload a file to use it in chat."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function FileCollectionStatus({
  state,
  collection,
  visible,
}: {
  state: FilesState
  collection: "files" | "trash"
  visible: number
}) {
  if (state.error) return null
  if (state.loading)
    return state.files.length ? null : (
      <DataLoading loading label="Loading files" />
    )
  return visible ? null : <EmptyFileCollection collection={collection} />
}
